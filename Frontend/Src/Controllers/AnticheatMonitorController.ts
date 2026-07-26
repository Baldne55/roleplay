import {
  AnticheatExpectedStateBagKey,
  MonitorReportIntervalMs,
} from '@Shared/Constants/Anticheat.js';
import { EquippedWeaponBagKey } from '@Shared/Constants/Inventory.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
declare function PlayerPedId(): number;
declare function PlayerId(): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetUsingnightvision(): boolean;
declare function GetUsingseethrough(): boolean;
declare function GetPlayerInvincible_2(Player: number): boolean;
declare function GetPlayerStamina(PlayerId: number): number;
declare function GetPlayerMaxStamina(PlayerId: number): number;
declare function GetEntityAlpha(Entity: number): number;
declare function GetFinalRenderedCamCoord(): number[];
declare function GetLocalPlayerAimState_2(): number;
declare function GetAmmoInClip(Ped: number, WeaponHash: number): [boolean, number];
declare function GetMaxAmmoInClip(Ped: number, WeaponHash: number, P2: boolean): number;
declare function CanPedRagdoll(Ped: number): boolean;
declare function GetEntitySpeed(Entity: number): number;
declare function IsPedOnFoot(Ped: number): boolean;
declare function IsPedFalling(Ped: number): boolean;
declare function IsEntityInAir(Entity: number): boolean;
declare function GetPedParachuteState(Ped: number): number;
declare function IsPedSprinting(Ped: number): boolean;
declare function IsPedInAnyVehicle(Ped: number, AtGetIn: boolean): boolean;
declare function IsCinematicCamRendering(): boolean;
declare function IsPlayerFreeAiming(Player: number): boolean;
declare function IsUsingKeyboard(PadIndex: number): boolean;
declare function IsInputDisabled(PadIndex: number): boolean;
declare const LocalPlayer: {
  state: {
    set(Key: string, Value: unknown, Replicated: boolean): void;
    [Key: string]: unknown;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Rendered-cam distance beyond which a cycle counts toward the FreeCam
 * flag. The vehicle cinematic camera orbits well inside this radius;
 * detached free cameras sit far outside it.
 */
const FreeCamDistanceMeters = 15;
/** GetLocalPlayerAimState_2 free-aim value; 0/1/2 are the assisted modes. */
const FreeAimState = 3;
/**
 * On-foot speed above which a cycle counts as sprint-movement. The
 * engine sprint tops out near 7 m/s; jogging stays under 5.
 */
const SprintSpeedMps = 6;
/** Continuous sprint-movement required before the stamina comparison fires. */
const SprintSustainMs = 10_000;
/**
 * GetPedParachuteState value for a ped with no parachute activity. Every
 * other value (0 stowed, 1 opening, 2 open, 3 falling-to-doom) means the
 * ped is mid-descent and must not count toward the sprint run.
 */
const ParachuteStateNormal = -1;
/**
 * Control-system instance handed to the input-device read. Instance 2
 * (FRONTEND_CONTROL) is the idiomatic choice; every instance reports
 * the same physical device.
 */
const PadFrontend = 2;
/** Fully opaque entity alpha. */
const FullAlpha = 255;
/**
 * Grace after the monitor starts (i.e. after CharacterSpawned) during
 * which the spawn-sensitive checks - ClientInvincibility and
 * PedAlphaTampering - are skipped. The engine reports spawn-protection
 * invincibility and a briefly not-fully-faded-in ped in this window;
 * neither is a cheat. Sized a little longer than the server scanner's
 * 10 s spawn grace to cover the client-side fade-in tail.
 */
const SpawnGraceMs = 12_000;

/** Replicated expected-noclip mirror key, resolved once at module load. */
const NoClipBagKey = AnticheatExpectedStateBagKey('NoClip');

/**
 * How long `/ac test silence` keeps the monitor down before resuming.
 * Long enough for the Backend's 30-second silence threshold plus one
 * 15-second watchdog tick to fire; short enough that the tester's own
 * session does not stay degraded.
 */
const TestSilenceResumeMs = 60_000;

/**
 * The report this client sends each cycle. Built locally from engine
 * natives, so unlike the server's view of the same type every field here
 * is trusted at construction - the hostile-payload handling happens on
 * the receiving end, in AnticheatController.
 */
type MonitorReport = NetEventPayloads[typeof NetEvents.AnticheatMonitorReport];

/**
 * Client anti-cheat monitor - the tier-3 self-report half of the
 * pipeline. A setInterval at MonitorReportIntervalMs samples local
 * engine state and emits ONE `Roleplay:Net:Anticheat:MonitorReport`
 * per cycle, flagged or not: the steady cadence is itself the
 * heartbeat, and the Backend raises MonitorSilent against any Source
 * that stays spawned while the reports stop.
 *
 * Per-cycle checks (each one a payload field):
 *
 *   1. NightVision / ThermalVision - the two post-FX getters, raw.
 *   2. ClientInvincibility - the player-invincibility flag
 *      (GetPlayerInvincible_2 also catches the keep-ragdoll variant)
 *      while the server has not sanctioned noclip and the spawn grace
 *      has elapsed (spawn protection sets the flag legitimately).
 *   3. FreeCam - rendered-cam distance from the ped over 15 m on two
 *      consecutive cycles; the distance rides along when flagged.
 *      Skipped while in a vehicle or under a cinematic cam (the engine's
 *      own chase cam sits far behind large vehicles).
 *   4. AimAssistOn - an assisted aim mode while the input device reads
 *      keyboard-and-mouse AND the player is actively free-aiming, held
 *      across two consecutive cycles (controller players legitimately
 *      use the assisted modes, and hybrid keyboard-plus-pad players must
 *      not score on a single coincidental frame). The raw aim state
 *      ships every cycle as telemetry either way.
 *   5. InfiniteStamina - stamina still at max after 10+ continuous
 *      seconds of genuine ground sprint (on foot, sprinting, not
 *      falling, airborne, or parachuting).
 *   6. OverMaxClip - clip ammo above the component-aware engine
 *      maximum for the equipped weapon (read from the replicated
 *      `Roleplay:EquippedWeapon` bag, the InventoryController idiom).
 *   7. RagdollHack - CanPedRagdoll false on two consecutive cycles
 *      while not incapacitated, not in sanctioned noclip, and not in a
 *      vehicle (a seated ped legitimately cannot ragdoll).
 *   8. PedAlphaTampering - own-ped alpha under opaque on two consecutive
 *      cycles, outside sanctioned noclip and the spawn grace. The local
 *      visibility check was dropped as a false-positive source (see
 *      SamplePedAlpha).
 *
 * The whole sample body sits in a try/catch: a native hiccup skips the
 * cycle (one missed heartbeat, well inside the silence threshold)
 * rather than killing the interval.
 *
 * Lifecycle mirrors the InjuryController health poll: CharacterSpawned
 * starts the interval, SessionReturnToSelect / SessionReturnToAuth
 * stop it and clear the cross-cycle trackers.
 *
 * Every native declared above is verified against the
 * `@citizenfx/client` typings (node_modules/@citizenfx/client/
 * natives_universal.d.ts, 2.0.29753-1).
 */
export class AnticheatMonitorController {
  private readonly Log = Logger.New('AnticheatMonitor');

  private IsSpawned = false;
  /** Active setInterval handle for the report cycle, null when not running. */
  private ReportInterval: ReturnType<typeof setInterval> | null = null;

  /** Previous cycle breached the FreeCam distance - the flag needs two in a row. */
  private FreeCamFarLastCycle = false;
  /** Previous cycle observed ragdoll blocked - the flag needs two in a row. */
  private RagdollBlockedLastCycle = false;
  /** Previous cycle observed assisted aim on keyboard - the flag needs two in a row. */
  private AimAssistLastCycle = false;
  /** Previous cycle observed sub-opaque ped alpha - the flag needs two in a row. */
  private AlphaLowLastCycle = false;
  /** Wall-clock when the current continuous sprint-movement run began; null when idle. */
  private SprintingSinceMs: number | null = null;
  /** Wall-clock the monitor last started (the spawn moment); null when not running. */
  private SpawnedAtMs: number | null = null;

  constructor() {
    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
      this.StartMonitor();
    });

    const ReturnHandler = (): void => {
      this.IsSpawned = false;
      this.StopMonitor();
    };
    onNet(NetEvents.SessionReturnToSelect, ReturnHandler);
    onNet(NetEvents.SessionReturnToAuth, ReturnHandler);

    onNet(NetEvents.AnticheatTestDirective, (Payload: NetEventPayloads[typeof NetEvents.AnticheatTestDirective]): void => {
      this.HandleTestDirective(Payload);
    });

    this.Log.Debug('Handlers registered (CharacterSpawned, SessionReturnTo*, TestDirective)');
  }

  /**
   * `/ac test` harness (server-initiated; the command is Founder-gated
   * server-side, the client merely executes the directive on itself).
   *
   *   BagWrite - replicate a write to a `Roleplay:`-prefixed key on the
   *   own player bag, exactly the move a cheat would make against the
   *   server-owned mirrors. Confirms (or refutes) the tamper watch's
   *   Reserved-argument origin signal without any cheat tooling.
   *
   *   MonitorSilence - stop the report cycle so the Backend's silence
   *   watchdog fires, then resume automatically.
   */
  private HandleTestDirective(Payload: NetEventPayloads[typeof NetEvents.AnticheatTestDirective]): void {
    if (Payload.Case === 'BagWrite') {
      try {
        LocalPlayer.state.set('Roleplay:AnticheatCanary', Date.now(), true);
        this.Log.Info('Test directive: canary bag write replicated');
      } catch (Err: unknown) {
        this.Log.Warn('Test directive: canary bag write threw', { Err: String(Err) });
      }
      return;
    }
    if (Payload.Case === 'MonitorSilence') {
      this.Log.Info(`Test directive: monitor silenced for ${TestSilenceResumeMs}ms`);
      this.StopMonitor();
      setTimeout((): void => {
        if (this.IsSpawned) this.StartMonitor();
      }, TestSilenceResumeMs);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Begin the client-side sampling loop that heartbeats to the server.
   *
   * Client-side detection is advisory only - a modded client can silence
   * it. That is accounted for: the server's watchdog treats missing
   * heartbeats as a signal in itself.
   */
  private StartMonitor(): void {
    if (this.ReportInterval !== null) return;
    this.ResetCycleTrackers();
    // Anchor the spawn grace at the start moment (CharacterSpawned, or a
    // resume after the silence test) so the spawn-sensitive checks stay
    // quiet through the fade-in / spawn-protection window.
    this.SpawnedAtMs = Date.now();
    this.ReportInterval = setInterval((): void => {
      this.SampleAndReport();
    }, MonitorReportIntervalMs);
  }

  /** Halt sampling, on despawn or character switch. */
  private StopMonitor(): void {
    if (this.ReportInterval === null) return;
    clearInterval(this.ReportInterval);
    this.ReportInterval = null;
    this.ResetCycleTrackers();
  }

  /**
   * Clear per-cycle accumulators between sampling windows, so one
   * window's readings cannot bleed into the next and produce a false
   * report after a legitimate teleport or respawn.
   */
  private ResetCycleTrackers(): void {
    this.FreeCamFarLastCycle = false;
    this.RagdollBlockedLastCycle = false;
    this.AimAssistLastCycle = false;
    this.AlphaLowLastCycle = false;
    this.SprintingSinceMs = null;
    this.SpawnedAtMs = null;
  }

  // ── Sample cycle ────────────────────────────────────────────────────

  /** Take one sample and send it as a heartbeat to the server watchdog. */
  private SampleAndReport(): void {
    if (!this.IsSpawned) return;
    try {
      const Ped = PlayerPedId();
      if (Ped === 0) return;
      const Payload = this.Sample(Ped);
      emitNet(NetEvents.AnticheatMonitorReport, Payload);
    } catch (Err: unknown) {
      // One skipped cycle is one missed heartbeat - far inside the
      // server's silence threshold. Never let a hiccup kill the loop.
      this.Log.Debug(`Sample cycle skipped`, { Err: String(Err) });
    }
  }

  /**
   * Read the local ped's state into a report - the things only a client
   * can observe (invincibility flags, movement modifiers) which the
   * server cannot query directly.
   */
  private Sample(Ped: number): MonitorReport {
    const Now = Date.now();
    const ExpectedNoClip = ReadExpectedNoClip();
    const Incapacitated = ReadIsIncapacitated();
    // Spawn-protection invincibility and a not-yet-faded-in ped both
    // read as cheats for the first seconds in the world; skip the two
    // spawn-sensitive checks until the grace elapses.
    const InSpawnGrace = this.SpawnedAtMs !== null && Now - this.SpawnedAtMs < SpawnGraceMs;

    const NightVision = GetUsingnightvision() === true;
    const ThermalVision = GetUsingseethrough() === true;
    const ClientInvincibility =
      !InSpawnGrace && !ExpectedNoClip && GetPlayerInvincible_2(PlayerId()) === true;
    const FreeCamDistance = this.SampleFreeCam(Ped);

    const AimState = Number(GetLocalPlayerAimState_2());
    const AimAssistOn = this.SampleAimAssist(AimState);

    const InfiniteStamina = this.SampleInfiniteStamina(Ped, Now);
    const Clip = this.SampleClip(Ped);
    const RagdollHack = this.SampleRagdoll(Ped, ExpectedNoClip, Incapacitated);
    const PedAlpha = this.SamplePedAlpha(Ped, ExpectedNoClip, InSpawnGrace);

    return {
      NightVision,
      ThermalVision,
      ClientInvincibility,
      FreeCamDistance,
      AimState: Number.isFinite(AimState) ? AimState : -1,
      AimAssistOn,
      InfiniteStamina,
      OverMaxClip: Clip.OverMaxClip,
      ClipAmmo: Clip.ClipAmmo,
      ClipMax: Clip.ClipMax,
      RagdollHack,
      PedAlphaTampering: PedAlpha.Flagged,
      PedAlpha: PedAlpha.Flagged ? PedAlpha.Alpha : null,
    };
  }

  /**
   * Sub-opaque ped alpha on two consecutive cycles, outside sanctioned
   * noclip and the spawn grace. The standalone "not visible" check that
   * once shared this flag was dropped: IsEntityVisible reads LOCAL
   * visibility, which a network-invisibility cheat leaves true while
   * spawn fades, cutscenes, and interior loads routinely turn it false -
   * a high false-positive, near-zero-signal combination (the source of
   * the PedAlpha=255 false flag). A script-lowered alpha is the
   * meaningful self-invisibility signal and is kept.
   */
  private SamplePedAlpha(
    Ped: number,
    ExpectedNoClip: boolean,
    InSpawnGrace: boolean,
  ): { Flagged: boolean; Alpha: number } {
    const Alpha = Number(GetEntityAlpha(Ped));
    if (InSpawnGrace || ExpectedNoClip || !Number.isFinite(Alpha)) {
      this.AlphaLowLastCycle = false;
      return { Flagged: false, Alpha };
    }
    const Low = Alpha < FullAlpha;
    const Flagged = Low && this.AlphaLowLastCycle;
    this.AlphaLowLastCycle = Low;
    return { Flagged, Alpha };
  }

  // ── Individual checks ───────────────────────────────────────────────

  /**
   * Distance between the final rendered camera and the ped. One far
   * cycle is routine (cinematic cam swings, scripted transitions); two
   * consecutive cycles - 10 s apart - is a camera detached from the
   * player. Returns the distance (one decimal) when flagged, null
   * otherwise.
   *
   * The sample is skipped outright while the ped is in any vehicle: the
   * engine's own chase cam sits far behind large vehicles (jets, planes,
   * buses), well past the free-cam radius. A scripted cinematic cam is
   * skipped for the same reason. On a skipped cycle the consecutive-far
   * tracker is reset so the two-cycle latch never carries a stale far
   * reading across a vehicle entry.
   */
  private SampleFreeCam(Ped: number): number | null {
    if (IsPedInAnyVehicle(Ped, false) === true || IsCinematicCamRendering() === true) {
      this.FreeCamFarLastCycle = false;
      return null;
    }
    const Cam = GetFinalRenderedCamCoord();
    const Coords = GetEntityCoords(Ped);
    const Dx = Number(Cam[0]) - Number(Coords[0]);
    const Dy = Number(Cam[1]) - Number(Coords[1]);
    const Dz = Number(Cam[2]) - Number(Coords[2]);
    const Distance = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
    if (!Number.isFinite(Distance)) return null;
    const Far = Distance > FreeCamDistanceMeters;
    const Flagged = Far && this.FreeCamFarLastCycle;
    this.FreeCamFarLastCycle = Far;
    return Flagged ? Math.round(Distance * 10) / 10 : null;
  }

  /**
   * Sprint-movement run tracking. A cycle counts only during genuine
   * ground sprint locomotion: on foot above sprint speed, actually
   * sprinting per the engine, and neither falling, airborne, nor
   * parachuting. The last three exclusions matter because a free fall,
   * a parachute descent, or a ride on top of a moving vehicle all clear
   * the on-foot-and-fast bar while burning no stamina - the run breaks
   * the moment any condition drops. Once the run spans SprintSustainMs
   * the engine must have drained stamina below max, so a max read at
   * that point is a regen cheat.
   */
  private SampleInfiniteStamina(Ped: number, Now: number): boolean {
    const SprintMoving =
      IsPedOnFoot(Ped) === true &&
      Number(GetEntitySpeed(Ped)) > SprintSpeedMps &&
      IsPedSprinting(Ped) === true &&
      IsPedFalling(Ped) === false &&
      IsEntityInAir(Ped) === false &&
      GetPedParachuteState(Ped) === ParachuteStateNormal;
    if (!SprintMoving) {
      this.SprintingSinceMs = null;
      return false;
    }
    if (this.SprintingSinceMs === null) {
      this.SprintingSinceMs = Now;
      return false;
    }
    if (Now - this.SprintingSinceMs < SprintSustainMs) return false;
    const Max = Number(GetPlayerMaxStamina(PlayerId()));
    if (!Number.isFinite(Max) || Max <= 0) return false;
    const Stamina = Number(GetPlayerStamina(PlayerId()));
    return Number.isFinite(Stamina) && Stamina >= Max;
  }

  /**
   * Clip-vs-maximum comparison, only while a weapon is in hand per the
   * replicated equipped-weapon bag. GetMaxAmmoInClip is component-aware
   * (extended magazines raise it), so a clip over it has no legitimate
   * source. P2 rides as true - the value the decompiled scripts pass.
   */
  private SampleClip(Ped: number): {
    OverMaxClip: boolean;
    ClipAmmo: number | null;
    ClipMax: number | null;
  } {
    const NotFlagged = { OverMaxClip: false, ClipAmmo: null, ClipMax: null };
    const WeaponHash = ReadEquippedWeaponHash();
    if (WeaponHash === null) return NotFlagged;
    const [HasClip, RawClip] = GetAmmoInClip(Ped, WeaponHash);
    const ClipAmmo = Number(RawClip);
    if (HasClip !== true || !Number.isFinite(ClipAmmo)) return NotFlagged;
    const ClipMax = Number(GetMaxAmmoInClip(Ped, WeaponHash, true));
    if (!Number.isFinite(ClipMax) || ClipMax <= 0) return NotFlagged;
    if (ClipAmmo <= ClipMax) return NotFlagged;
    return { OverMaxClip: true, ClipAmmo, ClipMax };
  }

  /**
   * CanPedRagdoll false outside the sanctioned states (incapacitation
   * runs a scripted pose; noclip freezes the ped) on two consecutive
   * cycles. Single-cycle blocks are common - any scripted animation
   * may clear the ragdoll flag for its duration.
   *
   * The sample is skipped while the ped is in any vehicle: a seated ped
   * legitimately cannot ragdoll, so every driver and passenger would
   * otherwise score. On a skipped cycle the consecutive-blocked tracker
   * is reset so the two-cycle latch never carries a stale block across a
   * vehicle entry.
   */
  private SampleRagdoll(Ped: number, ExpectedNoClip: boolean, Incapacitated: boolean): boolean {
    if (IsPedInAnyVehicle(Ped, false) === true) {
      this.RagdollBlockedLastCycle = false;
      return false;
    }
    const Blocked = !ExpectedNoClip && !Incapacitated && CanPedRagdoll(Ped) === false;
    const Flagged = Blocked && this.RagdollBlockedLastCycle;
    this.RagdollBlockedLastCycle = Blocked;
    return Flagged;
  }

  /**
   * An assisted aim mode while the input device reads keyboard-and-mouse
   * and the player is actively free-aiming. The raw AimState always
   * ships as telemetry; this returns only the flag.
   *
   * Two guards keep hybrid keyboard-plus-controller players (push-to-talk
   * or typing while a pad provides aim assist) from scoring:
   *
   *   - The condition must hold across TWO consecutive cycles, like the
   *     FreeCam and Ragdoll latches. A single keyboard read coinciding
   *     with an assisted-aim frame is routine; ten seconds of it is not.
   *   - The player must be actively free-aiming (IsPlayerFreeAiming).
   *     Assisted aim that is reported while not aiming carries no
   *     gameplay advantage and is excluded.
   *
   * ReadKeyboardAndMouse returns null when neither alias of
   * _IS_USING_KEYBOARD resolves; the flag then stays down (and the latch
   * is reset) so a controller player never scores for the engine's own
   * assisted modes.
   */
  private SampleAimAssist(AimState: number): boolean {
    const KeyboardAndMouse = ReadKeyboardAndMouse();
    const Assisted =
      KeyboardAndMouse === true &&
      AimState !== FreeAimState &&
      IsPlayerFreeAiming(PlayerId()) === true;
    const Flagged = Assisted && this.AimAssistLastCycle;
    this.AimAssistLastCycle = Assisted;
    return Flagged;
  }
}

// ── State-bag reads (direct LocalPlayer.state - the established idiom) ─

/** Server-mirrored expected-noclip bit; anything but `true` reads as off. */
function ReadExpectedNoClip(): boolean {
  return LocalPlayer.state[NoClipBagKey] === true;
}

/**
 * Non-Healthy InjuryStatus per the replicated bag. Unknown or absent
 * values read as Healthy - the same fail-open normalisation the
 * InjuryController applies.
 */
function ReadIsIncapacitated(): boolean {
  const Raw = LocalPlayer.state[NametagBagKeys.InjuryStatus];
  return Raw === 'Unconscious' || Raw === 'BadlyWounded' || Raw === 'Dead';
}

/**
 * Equipped weapon hash from the replicated `Roleplay:EquippedWeapon`
 * bag (the InventoryController's wire shape); null when unequipped or
 * malformed.
 */
function ReadEquippedWeaponHash(): number | null {
  const Raw = LocalPlayer.state[EquippedWeaponBagKey];
  if (Raw === null || Raw === undefined || typeof Raw !== 'object') return null;
  const WeaponHash = Number((Raw as { WeaponHash?: unknown }).WeaponHash);
  return Number.isFinite(WeaponHash) ? WeaponHash : null;
}

/**
 * True when the last input device was keyboard-and-mouse. The engine
 * native is _IS_USING_KEYBOARD (0xA571D46727E2B718); the
 * `@citizenfx/client` typings expose it under both `IsUsingKeyboard`
 * and the historical `IsInputDisabled`, so the read tries the modern
 * alias first and falls back (the InventoryController's ReadPedAmmo
 * idiom). Null when neither resolves - the caller then never flags.
 */
function ReadKeyboardAndMouse(): boolean | null {
  try {
    return IsUsingKeyboard(PadFrontend) === true;
  } catch {
    // Alias missing on this build; try the historical name.
  }
  try {
    return IsInputDisabled(PadFrontend) === true;
  } catch {
    return null;
  }
}
