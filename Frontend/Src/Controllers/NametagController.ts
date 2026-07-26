import {
  NametagBagKeys,
  NametagColors,
  NametagCullMarginMeters,
  NametagDamageFlashMs,
  NametagHeadOffsetZ,
  NametagLosIntervalMs,
  NametagMaxDistance,
  NametagMaxScale,
  NametagMinScale,
  NametagSnapshotIntervalMs,
} from '@Shared/Constants/Nametag.js';
import { NetEvents } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function setTick(Callback: () => void): number;
declare function GetActivePlayers(): number[];
declare function PlayerId(): number;
declare function GetPlayerPed(PlayerSrc: number | string): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetEntityCoords(
  Entity: number,
  Alive: boolean,
): [number, number, number] & { x: number; y: number; z: number };
declare function GetPedBoneCoords(
  Ped: number,
  BoneId: number,
  OffsetX: number,
  OffsetY: number,
  OffsetZ: number,
): [number, number, number] & { x: number; y: number; z: number };
declare function GetGameplayCamCoord(): [number, number, number] & {
  x: number;
  y: number;
  z: number;
};
declare function StartExpensiveSynchronousShapeTestLosProbe(
  X1: number,
  Y1: number,
  Z1: number,
  X2: number,
  Y2: number,
  Z2: number,
  Flags: number,
  IgnoreEntity: number,
  P9: number,
): number;
declare function GetShapeTestResult(
  Handle: number,
): [number, boolean, [number, number, number], [number, number, number], number];
declare function SetDrawOrigin(X: number, Y: number, Z: number, P3: number): void;
declare function ClearDrawOrigin(): void;
declare function SetTextScale(P0: number, Scale: number): void;
declare function SetTextFont(Font: number): void;
declare function SetTextProportional(P0: boolean): void;
declare function SetTextColour(R: number, G: number, B: number, A: number): void;
declare function SetTextOutline(): void;
declare function SetTextCentre(Align: boolean): void;
declare function SetTextDropshadow(
  Distance: number,
  R: number,
  G: number,
  B: number,
  A: number,
): void;
declare function BeginTextCommandDisplayText(Text: string): void;
declare function AddTextComponentSubstringPlayerName(Text: string): void;
declare function EndTextCommandDisplayText(X: number, Y: number): void;
declare const LocalPlayer: {
  state: { [Key: string]: unknown };
};
declare function Player(Source: number | string): {
  state: { [Key: string]: unknown };
};
/* eslint-enable @typescript-eslint/naming-convention */

/** Head bone index. SKEL_Head on every freemode ped; lc-rp parity. */
const HeadBoneIndex = 31086;

/**
 * Cached line-of-sight verdict for one ped. The raycast is far too
 * expensive to run per player per frame, so results are held for a short
 * TTL; `CheckedAt` is what expires them.
 */
interface LosEntry {
  Visible: boolean;
  CheckedAt: number;
}

/**
 * Cached state-bag read for one player, with the stamp that expires it.
 * Same motivation as LosEntry - the bag read is cheap but not free, and
 * nametag data changes far slower than the render tick.
 */
interface SnapshotEntry {
  Snap: RuntimeSnapshot;
  ReadAt: number;
}

/**
 * Everything the overlay needs about one player, lifted out of their
 * replicated state bag into a plain typed object.
 *
 * This is a *view* of server-published state, never a source of truth:
 * the server writes these bag keys, and a modded client editing its own
 * copy changes only what its own screen draws. Nothing here is read back
 * for any gameplay decision.
 */
interface RuntimeSnapshot {
  CharacterID: string | null;
  DisplayName: string | null;
  IsMinor: boolean;
  InjuryStatus: string;
  Action: string | null;
  IsTyping: boolean;
  DamageFlash: number;
  AdminDuty: boolean;
  AdminDutyLabel: string;
  AdminDutyName: string;
}

/**
 * In-world nametag overlay.
 *
 * Renders a stacked text tower above every spawned player ped within
 * 15m of the camera. Lines, top to bottom:
 *
 *   1. /ame /amy action       (purple, wraps to ~35-55 chars)
 *   2. Injury OOC indicator   (red, only when not Healthy)
 *   3. Typing indicator       (orange `[...]`)
 *   4. Name + Source ID       (white / yellow when on duty,
 *                              red while DamageFlash window open)
 *
 * Architecture:
 *   - One `setTick` registers the render hook. Every frame iterates
 *     `GetActivePlayers()` (engine-streamed roster - already filtered by
 *     routing bucket via OneSync).
 *   - LOS raycasts run on a 300ms cache to avoid per-frame raycast cost.
 *   - State-bag snapshots run on a 200ms cache for the same reason -
 *     ~10 bag reads per player per frame would cross the JS<->native
 *     boundary thousands of times a second for text that never changes
 *     at frame rate. Head position / distance / fade stay per-frame.
 *   - Distance fades linearly to invisible at 15m; scale linearly drops
 *     from 0.45 (close) to 0.30 (far).
 *   - Local player's nametag only renders when /toggle selfnametag is
 *     on (read from LocalPlayer.state.NametagSelfVisible).
 *   - Damage flash: written server-side by the Backend's
 *     weaponDamageEvent hook; this side only reads the bag and
 *     renders the 600ms red flash.
 *
 * Spawn gate: nothing renders until CharacterSpawned arrives so the
 * auth shell / selector scene stays clean. SessionReturnToSelect /
 * SessionReturnToAuth flips the gate off so the next spawn re-arms.
 */
export class NametagController {
  private readonly Log = Logger.New('Nametag');

  private IsSpawned = false;
  private readonly Los = new Map<number, LosEntry>();
  /** ServerId -> cached bag snapshot (NametagSnapshotIntervalMs TTL). */
  private readonly Snapshots = new Map<number, SnapshotEntry>();

  constructor() {
    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
    });
    const ReturnHandler = (): void => {
      this.IsSpawned = false;
      this.Los.clear();
      this.Snapshots.clear();
    };
    onNet(NetEvents.SessionReturnToSelect, ReturnHandler);
    onNet(NetEvents.SessionReturnToAuth, ReturnHandler);

    setTick((): void => {
      this.OnTick();
    });

    this.Log.Debug('Tick registered (gated on CharacterSpawned)');
  }

  /**
   * Per-frame nametag pass over nearby players.
   *
   * Culls hardest first, because this runs every frame for every player
   * on screen: a cheap `GetEntityCoords` distance test rejects the
   * majority before the more expensive bone lookup and cached raycast are
   * reached.
   */
  private OnTick(): void {
    if (!this.IsSpawned) return;

    const SelfPed = GetPlayerPed(-1);
    if (SelfPed === 0) return;

    const Cam = SafeXYZ(GetGameplayCamCoord());
    if (Cam === null) return;

    const SelfId = PlayerId();
    const ShowSelf = ReadLocalBool(NametagBagKeys.SelfVisible, false);
    const ShowID = ReadLocalBool(NametagBagKeys.IDVisible, true);

    for (const Pid of GetActivePlayers()) {
      const IsSelf = Pid === SelfId;
      if (IsSelf && !ShowSelf) continue;

      const Ped = GetPlayerPed(Pid);
      if (Ped === 0) continue;

      const ServerId = GetPlayerServerId(Pid);
      if (ServerId <= 0) continue;

      const Snap = this.SnapshotFor(ServerId);
      if (Snap.CharacterID === null || Snap.DisplayName === null) continue;

      // Cheap pre-cull on the entity origin before resolving the head
      // bone. GetPedBoneCoords walks the ped's skeleton and was being
      // paid for every active player every frame, only for most of them
      // to fail the range test immediately after. The margin covers the
      // origin-to-head offset so nobody who belongs on screen is culled
      // by the approximation.
      const Body = SafeXYZ(GetEntityCoords(Ped, true));
      if (Body === null) continue;
      const Bdx = Body.X - Cam.X;
      const Bdy = Body.Y - Cam.Y;
      const Bdz = Body.Z - Cam.Z;
      const CullRange = NametagMaxDistance + NametagCullMarginMeters;
      if (Bdx * Bdx + Bdy * Bdy + Bdz * Bdz > CullRange * CullRange) continue;

      const Head = SafeXYZ(GetPedBoneCoords(Ped, HeadBoneIndex, 0, 0, 0));
      if (Head === null) continue;

      const Dx = Head.X - Cam.X;
      const Dy = Head.Y - Cam.Y;
      const Dz = Head.Z - Cam.Z;
      const Dist = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
      if (Dist > NametagMaxDistance) continue;

      // Self is always visible to self; the camera is "inside" the
      // player's own collision so the LOS probe would always hit the
      // ped itself. Skip the raycast and force-show.
      if (!IsSelf) {
        const Visible = this.CheckLos(Pid, Cam, Head, SelfPed, Ped);
        if (!Visible) continue;
      }

      RenderTower(Head, Dist, ShowID, ServerId, Snap);
    }
  }

  /**
   * 300ms-cached LOS raycast from camera to head bone. Ignores both
   * the local ped (so the camera "leaving" the head doesn't count as
   * an occlusion) and the target ped (the target's own body shouldn't
   * block its own nametag at close range). Synchronous probe is fine
   * at this cadence - one ray per remote player per 300ms.
   */
  private CheckLos(
    Pid: number,
    Cam: { X: number; Y: number; Z: number },
    Head: { X: number; Y: number; Z: number },
    SelfPed: number,
    TargetPed: number,
  ): boolean {
    const Now = NowMs();
    const Cached = this.Los.get(Pid);
    if (Cached !== undefined && Now - Cached.CheckedAt < NametagLosIntervalMs) {
      return Cached.Visible;
    }

    // Trace flags: 1=world, 16=vegetation, 256=objects. Skip peds + vehicles
    // so a passer-by between camera and target doesn't occlude. The
    // ignoreEntity slot only takes one handle; pass the local ped (the
    // most likely false-positive) and accept that the target's own body
    // can still produce a hit at point-blank range.
    let Visible = true;
    try {
      const Handle = StartExpensiveSynchronousShapeTestLosProbe(
        Cam.X,
        Cam.Y,
        Cam.Z + 0.1,
        Head.X,
        Head.Y,
        Head.Z,
        1 | 16 | 256,
        SelfPed,
        7,
      );
      const Result = GetShapeTestResult(Handle);
      const Hit = Result[1] === true;
      const HitEntity = Result[4];
      Visible = !Hit || HitEntity === TargetPed;
    } catch {
      Visible = true;
    }

    this.Los.set(Pid, { Visible, CheckedAt: Now });
    return Visible;
  }

  /**
   * 200ms-cached state-bag snapshot per ServerId. The tag content
   * (name, status, action, flash stamp) changes on human timescales;
   * re-reading ten bag keys per player per frame is pure native-
   * boundary overhead. Worst case a change lands one cache window
   * late - imperceptible against the 600ms flash and 5s action TTLs.
   */
  private SnapshotFor(ServerId: number): RuntimeSnapshot {
    const Now = NowMs();
    const Cached = this.Snapshots.get(ServerId);
    if (Cached !== undefined && Now - Cached.ReadAt < NametagSnapshotIntervalMs) {
      return Cached.Snap;
    }
    const Snap = ReadSnapshot(ServerId);
    this.Snapshots.set(ServerId, { Snap, ReadAt: Now });
    return Snap;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Lift one player's nametag bag into a RuntimeSnapshot.
 *
 * Every field goes through a coercing reader with a default, because the
 * bag may be partially populated: a player who has connected but not yet
 * spawned has no character keys, and a key added in a later version is
 * simply absent on a session that started before it. A missing key must
 * degrade to a sensible default, never render `undefined` over someone's
 * head. A bag read that throws outright yields the empty snapshot.
 */
function ReadSnapshot(ServerId: number): RuntimeSnapshot {
  let Bag: Record<string, unknown> = {};
  try {
    Bag = Player(ServerId).state;
  } catch {
    return EmptySnapshot();
  }
  return {
    CharacterID: AsStringOrNull(Bag[NametagBagKeys.CharacterID]),
    DisplayName: AsStringOrNull(Bag[NametagBagKeys.DisplayName]),
    IsMinor: AsBool(Bag[NametagBagKeys.IsMinor], false),
    InjuryStatus: AsStringOrNull(Bag[NametagBagKeys.InjuryStatus]) ?? 'Healthy',
    Action: AsStringOrNull(Bag[NametagBagKeys.Action]),
    IsTyping: AsBool(Bag[NametagBagKeys.IsTyping], false),
    DamageFlash: AsNumber(Bag[NametagBagKeys.DamageFlash], 0),
    AdminDuty: AsBool(Bag[NametagBagKeys.AdminDuty], false),
    AdminDutyLabel: AsStringOrNull(Bag[NametagBagKeys.AdminDutyLabel]) ?? '',
    AdminDutyName: AsStringOrNull(Bag[NametagBagKeys.AdminDutyName]) ?? '',
  };
}

/**
 * The all-defaults snapshot: no character, healthy, nothing to show. Used
 * when a bag read fails so the caller always gets a well-formed object.
 */
function EmptySnapshot(): RuntimeSnapshot {
  return {
    CharacterID: null,
    DisplayName: null,
    IsMinor: false,
    InjuryStatus: 'Healthy',
    Action: null,
    IsTyping: false,
    DamageFlash: 0,
    AdminDuty: false,
    AdminDutyLabel: '',
    AdminDutyName: '',
  };
}

/**
 * Read one of the local player's own display preferences (the /toggle
 * settings) off their state bag, falling back to `Default`.
 *
 * Reads `LocalPlayer.state` rather than `Player(id).state` - these are
 * the viewer's own choices about what to draw, not published facts about
 * anyone else.
 */
function ReadLocalBool(Key: string, Default: boolean): boolean {
  try {
    const Bag = LocalPlayer.state as unknown as Record<string, unknown>;
    const Value = Bag[Key];
    if (typeof Value === 'boolean') return Value;
    return Default;
  } catch {
    return Default;
  }
}

/**
 * Render the stacked nametag tower at the given head position. Lines
 * are pushed bottom-up; SetDrawOrigin pins the 3D->2D projection for
 * us so per-line offsets are in normalised screen space (DrawText is
 * in [0,1] coords).
 */
function RenderTower(
  Head: { X: number; Y: number; Z: number },
  Dist: number,
  ShowID: boolean,
  ServerId: number,
  Snap: RuntimeSnapshot,
): void {
  const Scale = DistanceScale(Dist);
  const Alpha = DistanceAlpha(Dist);
  if (Alpha <= 0) return;

  // Build the line list bottom-up so the name (always present) sits
  // closest to the head and optional lines stack above it.
  const Lines: { Text: string; Color: readonly [number, number, number, number] }[] = [];

  // Bottom: name line. Admin-duty swaps both the displayed name and
  // the colour; the rank label rides as a `[Label]` prefix.
  const Displayed = Snap.AdminDuty && Snap.AdminDutyName.length > 0
    ? Snap.AdminDutyName
    : Snap.DisplayName ?? 'Someone';
  const Prefix = Snap.AdminDuty && Snap.AdminDutyLabel.length > 0
    ? `[${Snap.AdminDutyLabel}] `
    : '';
  const Suffix = Snap.IsMinor ? ' [M]' : '';
  const IDPart = ShowID ? ` (${ServerId})` : '';
  const NameText = `${Prefix}${Displayed}${IDPart}${Suffix}`;
  const Flashing = NowMs() - Snap.DamageFlash < NametagDamageFlashMs;
  const NameColor = Flashing
    ? NametagColors.Injury
    : Snap.AdminDuty
      ? NametagColors.AdminDuty
      : NametagColors.Name;
  Lines.push({ Text: NameText, Color: NameColor });

  // Typing indicator sits above the name.
  if (Snap.IsTyping) {
    Lines.push({ Text: '[...]', Color: NametagColors.Typing });
  }

  // Injury OOC line (skipped while Healthy).
  const InjuryLine = InjuryOocLine(Snap.InjuryStatus);
  if (InjuryLine !== null) {
    Lines.push({ Text: InjuryLine, Color: NametagColors.Injury });
  }

  // /ame /amy action sits at the top of the stack.
  if (Snap.Action !== null && Snap.Action.length > 0) {
    Lines.push({ Text: Snap.Action, Color: NametagColors.Action });
  }

  // SetDrawOrigin pins the (0,0) screen anchor to the world head pos.
  // Each subsequent DrawText call draws at that anchor + (x, y) screen
  // offset. We stack upward by decreasing Y (smaller Y = higher).
  SetDrawOrigin(Head.X, Head.Y, Head.Z + NametagHeadOffsetZ, 0);
  try {
    const LineSpacing = 0.025 * (Scale / NametagMaxScale);
    for (let I = 0; I < Lines.length; I += 1) {
      const Y = -I * LineSpacing;
      const Line = Lines[I];
      if (Line === undefined) continue;
      DrawWorldText(Line.Text, Scale, Line.Color, Alpha, Y);
    }
  } finally {
    // Pairs with SetDrawOrigin on every path, throw included: an origin
    // left set would re-anchor the remaining players' towers (and any
    // other 2D draw this frame) to THIS player's head position.
    ClearDrawOrigin();
  }
}

/**
 * Draw one line of the nametag tower.
 *
 * Assumes SetDrawOrigin has already pinned the world position - the
 * caller sets it once per player and this draws several lines against it,
 * which is why `YOffset` is relative rather than absolute. Calling this
 * without an origin set puts text at the screen corner.
 *
 * Alpha is folded in as a multiplier over the colour's own alpha so
 * distance fade composes with a line's intrinsic transparency, and the
 * drop shadow fades in step - a shadow at full strength behind faded text
 * reads as a smudge.
 */
function DrawWorldText(
  Text: string,
  Scale: number,
  Color: readonly [number, number, number, number],
  AlphaMul: number,
  YOffset: number,
): void {
  const A = Math.max(0, Math.min(255, Math.round(Color[3] * AlphaMul)));
  SetTextScale(0, Scale);
  SetTextFont(4);
  SetTextProportional(true);
  SetTextColour(Color[0], Color[1], Color[2], A);
  SetTextDropshadow(2, 0, 0, 0, Math.round(180 * AlphaMul));
  SetTextOutline();
  SetTextCentre(true);
  BeginTextCommandDisplayText('STRING');
  AddTextComponentSubstringPlayerName(Text);
  // SetDrawOrigin pinned (0,0,headZ) to the screen; pass the offset
  // relative to that origin. X stays centred; Y stacks upward.
  EndTextCommandDisplayText(0, YOffset);
}

/**
 * OOC line for an incapacitated player, or null when they are fine.
 *
 * Deliberately out-of-character (`(( ))`) and phrased about "this
 * player", not the character: it exists so someone approaching a body
 * knows not to expect a reply, which is a player-to-player concern rather
 * than something their character perceives.
 */
function InjuryOocLine(Status: string): string | null {
  switch (Status) {
    case 'Unconscious':
      return '(( This player is unconscious. ))';
    case 'BadlyWounded':
      return '(( This player is badly wounded. ))';
    case 'Dead':
      return '(( This player is dead. ))';
    default:
      return null;
  }
}

/**
 * Text scale for a nametag at `Dist`, interpolating from NametagMaxScale
 * at the viewer's feet down to NametagMinScale at the draw limit.
 *
 * Shrinking with distance is what keeps a crowded street readable; the
 * floor stops far tags collapsing into an illegible smear.
 */
function DistanceScale(Dist: number): number {
  const T = Math.max(0, Math.min(1, Dist / NametagMaxDistance));
  return NametagMaxScale - T * (NametagMaxScale - NametagMinScale);
}

/**
 * Opacity multiplier for a nametag at `Dist` - linear from fully opaque
 * to fully transparent at the limit, so tags fade out rather than popping
 * when a player crosses the draw distance.
 */
function DistanceAlpha(Dist: number): number {
  const T = Math.max(0, Math.min(1, Dist / NametagMaxDistance));
  return 1 - T;
}

/**
 * Normalise a coordinate from either shape the CitizenFX natives return -
 * a `[x,y,z]` tuple or an `{x,y,z}` object - into PascalCase fields,
 * returning null if any component is not finite.
 *
 * Both shapes genuinely occur depending on the native and the runtime
 * build, and a non-finite component (from a ped that despawned mid-frame)
 * would otherwise propagate NaN into the distance maths and place text at
 * an undefined screen position.
 */
/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
function SafeXYZ(
  Raw:
    | [number, number, number]
    | { x: number; y: number; z: number }
    | undefined
    | null,
): { X: number; Y: number; Z: number } | null {
  if (Raw === null || Raw === undefined) return null;
  const X =
    typeof (Raw as { x: number }).x === 'number'
      ? (Raw as { x: number }).x
      : Number((Raw as [number, number, number])[0]);
  const Y =
    typeof (Raw as { y: number }).y === 'number'
      ? (Raw as { y: number }).y
      : Number((Raw as [number, number, number])[1]);
  const Z =
    typeof (Raw as { z: number }).z === 'number'
      ? (Raw as { z: number }).z
      : Number((Raw as [number, number, number])[2]);
  if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return null;
  return { X, Y, Z };
}
/* eslint-enable @typescript-eslint/naming-convention */

/*
 * ── State-bag coercers ───────────────────────────────────────────────
 *
 * State-bag values arrive as `unknown`. These three narrow by exact type
 * rather than coercing, so a key holding the wrong type falls back to the
 * default instead of rendering something like "[object Object]" over a
 * player's head. Absent and malformed are treated identically.
 */

/** Non-empty string, else null. Empty is treated as absent - a blank name is nothing to draw. */
function AsStringOrNull(V: unknown): string | null {
  if (typeof V === 'string' && V.length > 0) return V;
  return null;
}

/** Strict boolean, else the default. Never truthiness-tests. */
function AsBool(V: unknown, Default: boolean): boolean {
  if (typeof V === 'boolean') return V;
  return Default;
}

/** Finite number, else the default - NaN and Infinity are rejected. */
function AsNumber(V: unknown, Default: number): number {
  if (typeof V === 'number' && Number.isFinite(V)) return V;
  return Default;
}

/**
 * Monotonic-ish wall clock. The Frontend has no need for the harness
 * Date.now() rules - this runs in the FXServer client runtime where
 * Date.now() works as expected.
 */
function NowMs(): number {
  return Date.now();
}
