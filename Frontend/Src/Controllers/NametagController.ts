import {
  NametagBagKeys,
  NametagColors,
  NametagDamageFlashMs,
  NametagHeadOffsetZ,
  NametagLosIntervalMs,
  NametagMaxDistance,
  NametagMaxScale,
  NametagMinScale,
} from '@Shared/Constants/Nametag.js';
import { NetEvents } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';

declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function setTick(Callback: () => void): number;
declare function GetActivePlayers(): number[];
declare function PlayerId(): number;
declare function GetPlayerPed(PlayerSrc: number | string): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetEntityHealth(Entity: number): number;
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
  state: {
    set: (Key: string, Value: unknown, Replicated: boolean) => void;
    [Key: string]: unknown;
  };
};
declare function Player(Source: number | string): {
  state: { [Key: string]: unknown };
};

/** Head bone index. SKEL_Head on every freemode ped; lc-rp parity. */
const HeadBoneIndex = 31086;

interface LosEntry {
  Visible: boolean;
  CheckedAt: number;
}

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
 *   - Distance fades linearly to invisible at 15m; scale linearly drops
 *     from 0.45 (close) to 0.30 (far).
 *   - Local player's nametag only renders when /toggle selfnametag is
 *     on (read from LocalPlayer.state.NametagSelfVisible).
 *   - Damage flash: the local Frontend watches its own ped's HP each
 *     frame. On a drop it writes Date.now() to the replicated bag so
 *     every other client renders the 600ms red flash.
 *
 * Spawn gate: nothing renders until CharacterSpawned arrives so the
 * auth shell / selector scene stays clean. SessionReturnToSelect /
 * SessionReturnToAuth flips the gate off so the next spawn re-arms.
 */
export class NametagController {
  private readonly Log = Logger.New('Nametag');

  private IsSpawned = false;
  private LastSelfHealth = 200;
  private readonly Los = new Map<number, LosEntry>();

  constructor() {
    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
      this.LastSelfHealth = SafeHealth(GetPlayerPed(-1));
    });
    onNet(NetEvents.SessionReturnToSelect, (): void => {
      this.IsSpawned = false;
      this.Los.clear();
    });
    onNet(NetEvents.SessionReturnToAuth, (): void => {
      this.IsSpawned = false;
      this.Los.clear();
    });

    setTick((): void => {
      this.OnTick();
    });

    this.Log.Debug('Tick registered (gated on CharacterSpawned)');
  }

  private OnTick(): void {
    if (!this.IsSpawned) return;

    const SelfPed = GetPlayerPed(-1);
    if (SelfPed === 0) return;

    this.PublishDamageFlash(SelfPed);

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

      const Snap = ReadSnapshot(ServerId);
      if (Snap.CharacterID === null || Snap.DisplayName === null) continue;

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
   * Watch the local ped's health. When it drops below the last frame's
   * reading, write Date.now() to the replicated DamageFlash bag so
   * every other client renders the 600ms red flash on the local
   * player's nametag.
   *
   * FiveM convention: ped HP is 100..200 (100=dead, 200=full). We
   * compare on raw HP rather than the "real" 0..100 scale because the
   * raw value is what the natives return and the delta detection only
   * needs frame-to-frame monotonicity.
   */
  private PublishDamageFlash(SelfPed: number): void {
    const Current = SafeHealth(SelfPed);
    if (Current < this.LastSelfHealth) {
      try {
        LocalPlayer.state.set(NametagBagKeys.DamageFlash, NowMs(), true);
      } catch {
        // Headless dev run - no state bag surface.
      }
    }
    this.LastSelfHealth = Current;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────

function ReadSnapshot(ServerId: number): RuntimeSnapshot {
  let Bag: Record<string, unknown> = {};
  try {
    Bag = Player(ServerId).state as unknown as Record<string, unknown>;
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
  const LineSpacing = 0.025 * (Scale / NametagMaxScale);
  for (let I = 0; I < Lines.length; I += 1) {
    const Y = -I * LineSpacing;
    const Line = Lines[I];
    if (Line === undefined) continue;
    DrawWorldText(Line.Text, Scale, Line.Color, Alpha, Y);
  }
  ClearDrawOrigin();
}

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

function DistanceScale(Dist: number): number {
  const T = Math.max(0, Math.min(1, Dist / NametagMaxDistance));
  return NametagMaxScale - T * (NametagMaxScale - NametagMinScale);
}

function DistanceAlpha(Dist: number): number {
  const T = Math.max(0, Math.min(1, Dist / NametagMaxDistance));
  return 1 - T;
}

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

function SafeHealth(Ped: number): number {
  if (Ped === 0) return 200;
  try {
    const Raw = GetEntityHealth(Ped);
    return Number.isFinite(Raw) ? Raw : 200;
  } catch {
    return 200;
  }
}

function AsStringOrNull(V: unknown): string | null {
  if (typeof V === 'string' && V.length > 0) return V;
  return null;
}

function AsBool(V: unknown, Default: boolean): boolean {
  if (typeof V === 'boolean') return V;
  return Default;
}

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
