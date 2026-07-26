import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import {
  HealthPollIntervalMs,
  HpCriticalThreshold,
  RegenMaxHpDelta,
} from '@Shared/Constants/Injury.js';
import {
  WithdrawalDrainFloorHp,
  WithdrawalMaxAbsHpDelta,
} from '@Shared/Constants/Drugs.js';
import type { InjuryStatus } from '@Shared/Constants/Character.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
declare function setTick(Callback: () => void): number;
declare function clearTick(Handle: number): void;
declare function PlayerPedId(): number;
declare function PlayerId(): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetEntityHealth(Entity: number): number;
declare function SetEntityHealth(Entity: number, Health: number): void;
declare function SetEntityCoordsNoOffset(
  Entity: number,
  X: number,
  Y: number,
  Z: number,
  AliveFlag: boolean,
  DeadFlag: boolean,
  RagdollFlag: boolean,
): void;
declare function SetEntityHeading(Entity: number, Heading: number): void;
declare function DisableControlAction(PadIndex: number, Control: number, Disable: boolean): void;
declare function DisableAutomaticRespawn(Toggle: boolean): void;
declare function IgnoreNextRestart(Toggle: boolean): void;
declare function PauseDeathArrestRestart(Toggle: boolean): void;
declare function ThefeedHideThisFrame(): void;
declare function HideHudComponentThisFrame(Id: number): void;
declare function RequestAnimDict(Dict: string): void;
declare function HasAnimDictLoaded(Dict: string): boolean;
declare function TaskPlayAnim(
  Ped: number,
  AnimDict: string,
  AnimName: string,
  BlendInSpeed: number,
  BlendOutSpeed: number,
  Duration: number,
  Flag: number,
  PlaybackRate: number,
  LockX: boolean,
  LockY: boolean,
  LockZ: boolean,
): void;
declare function ClearPedTasksImmediately(Ped: number): void;
declare function ClearPedBloodDamage(Ped: number): void;
declare function ResetPedVisibleDamage(Ped: number): void;
declare function ClearPedWetness(Ped: number): void;
declare function ClearPedEnvDirt(Ped: number): void;
declare function AddStateBagChangeHandler(
  KeyFilter: string,
  BagFilter: string,
  Callback: (
    BagName: string,
    Key: string,
    Value: unknown,
    Reserved: number,
    Replicated: boolean,
  ) => void,
): number;
declare const LocalPlayer: {
  state: { [Key: string]: unknown };
};
/* eslint-enable @typescript-eslint/naming-convention */

/*
 * Dead-pose animation. Played instead of leaving the ped ragdolled so a
 * downed character settles into a stable, readable pose that other
 * players can find and interact with (/helpup), rather than sliding on
 * terrain.
 */
const DeadPoseDict = 'dead';
const DeadPoseClip = 'dead_a';
/** High blend-in: the pose should snap, not ease, once death is decided. */
const DeadPoseBlendIn = 8.0;
/**
 * Delay before the pose is applied, letting the engine's own death
 * ragdoll play out first. Applying immediately fights the ragdoll and the
 * ped visibly twitches between the two.
 */
const DeadPoseStartDelayMs = 500;

/**
 * Disabled controls while non-Healthy. Each fires once per frame inside
 * the suppression tick. List covers attack / aim / detonate / reload /
 * weapon-wheel / enter-vehicle / grenade throw / every melee variant -
 * the player can still mouse-look (it is what the dead pose anchors
 * against) but can not act.
 */
const DisabledControls: readonly number[] = [
  24, 25, 47, 37, 23, 45, 58, 140, 141, 142, 257, 263, 264,
];

/**
 * Client half of the injury surface. Three jobs:
 *
 *   1. Health-poll tick (250 ms). Watches own ped HP via GetEntityHealth
 *      (0-200 GTA range, 100=alive floor). When the value crosses below
 *      `100 + HpCriticalThreshold` while still in a Healthy state, emit
 *      `Roleplay:Net:Injury:HealthCritical` so the server can clamp,
 *      advance, and broadcast narration. Local 1 s spam guard sits on
 *      top of the server's 10 s cascade cooldown.
 *
 *   2. State-bag change handler on `Roleplay:InjuryStatus` for the local
 *      ped. On `Healthy -> non-Healthy`: 500 ms delay then loop the
 *      `dead/dead_a` animation, engage invincibility + suppression flag.
 *      On `non-Healthy -> Healthy`: clear tasks, release flags.
 *
 *   3. Suppression + combat-lock tick (setTick, only registered while
 *      the suppression flag is on). Per frame: disable the automatic
 *      respawn timer, ignore the next restart, pause the death/arrest
 *      cycle, hide the WANTED stars and feed (so WASTED text never
 *      appears), disable the attack / aim / reload / enter-vehicle /
 *      melee control set.
 *
 * Lifecycle: gated on `IsSpawned` (CharacterSpawned -> on,
 * SessionReturnToSelect / SessionReturnToAuth -> off). Mirrors the
 * NametagController gate; an event that lands in the auth shell or
 * selector goes nowhere.
 */
export class InjuryController {
  private readonly Log = Logger.New('Injury');

  private IsSpawned = false;
  /**
   * Cached server-side InjuryStatus. We track it locally instead of
   * re-reading `LocalPlayer.state` on every tick because the bag read
   * surfaces unknown-shape data and we want a stable typed value.
   * Updated by the state-bag handler on every server flip + on
   * CharacterSpawned for the initial value.
   */
  private CurrentStatus: InjuryStatus = 'Healthy';
  /** Wall-clock of the last HealthCritical emit; local 1 s spam guard. */
  private LastEmitAt = 0;
  /** Active setTick handle for the suppression loop, null when not running. */
  private SuppressionTick: number | null = null;
  /** Active setInterval handle for the health poll, null when not running. */
  private PollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Pre-load the dead animation so the 500 ms TaskPlayAnim delay does
    // not race the asset stream on the first collapse.
    RequestAnimDict(DeadPoseDict);

    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
      this.StartHealthPoll();
      // The state-bag may already carry the persisted status by the
      // time CharacterSpawned lands - the server's Attach writes it
      // before the spawn event. Sync our local cached value + apply
      // the visual state if we are coming back already-injured.
      const Status = ReadLocalInjuryStatus();
      this.CurrentStatus = Status;
      if (Status !== 'Healthy') this.EnterIncapacitated();
    });

    // Authoritative HP / armour / teleport coming back from the server
    // after each state transition. The server reads ped state but
    // cannot write it - SetEntityHealth / SetPedArmour /
    // SetEntityCoordsNoOffset are client-only natives in FXServer - so
    // the round-trip is by design.
    onNet(
      NetEvents.InjuryApply,
      (Payload: NetEventPayloads[typeof NetEvents.InjuryApply]): void => {
        if (!this.IsSpawned) return;
        this.ApplyPedState(Payload);
      },
    );

    // Server-driven consumable regen (the medkit's over-time window).
    // Relative positive delta with the bleeding drain tick's guards
    // mirrored: malformed or oversized payloads drop on the floor.
    onNet(
      NetEvents.InjuryRegenTick,
      (Payload: NetEventPayloads[typeof NetEvents.InjuryRegenTick]): void => {
        if (!this.IsSpawned) return;
        this.ApplyRegenTick(Payload);
      },
    );

    // Withdrawal symptom drain. Same relative-delta shape, opposite
    // sign, with its own (high) floor - withdrawal harasses, the
    // injury machine is the only road to the ground.
    onNet(
      NetEvents.AddictionWithdrawalTick,
      (Payload: NetEventPayloads[typeof NetEvents.AddictionWithdrawalTick]): void => {
        if (!this.IsSpawned) return;
        this.ApplyWithdrawalTick(Payload);
      },
    );

    const ReturnHandler = (): void => {
      this.IsSpawned = false;
      this.StopHealthPoll();
      if (this.CurrentStatus !== 'Healthy') this.ExitIncapacitated();
      this.CurrentStatus = 'Healthy';
    };
    onNet(NetEvents.SessionReturnToSelect, ReturnHandler);
    onNet(NetEvents.SessionReturnToAuth, ReturnHandler);

    // FX state bags publish under `player:<serverId>`. Filter on the
    // InjuryStatus key only; check the bag name inside the handler so a
    // mid-session server-id reassignment (does not happen today, but
    // cheap to guard) does not need a re-register.
    AddStateBagChangeHandler(
      NametagBagKeys.InjuryStatus,
      '',
      (BagName, _Key, Value): void => {
        if (!this.IsSpawned) return;
        const SelfBag = `player:${GetPlayerServerId(PlayerId())}`;
        if (BagName !== SelfBag) return;
        const Next = NormaliseInjuryStatus(Value);
        if (Next === this.CurrentStatus) return;
        const Prev = this.CurrentStatus;
        this.CurrentStatus = Next;
        if (Prev === 'Healthy' && Next !== 'Healthy') {
          this.EnterIncapacitated();
        } else if (Prev !== 'Healthy' && Next === 'Healthy') {
          this.ExitIncapacitated();
        }
        this.Log.Debug(`InjuryStatus ${Prev} -> ${Next}`);
      },
    );

    this.Log.Debug('Handlers registered (CharacterSpawned, SessionReturnTo*, InjuryStatus bag)');
  }

  // ── Health poll ─────────────────────────────────────────────────────

  /**
   * Begin sampling local HP and reporting it to the server, which has no
   * way to observe engine health directly.
   */
  private StartHealthPoll(): void {
    if (this.PollInterval !== null) return;
    this.PollInterval = setInterval((): void => {
      this.PollHealth();
    }, HealthPollIntervalMs);
  }

  /** Stop the health poll on despawn or character switch. */
  private StopHealthPoll(): void {
    if (this.PollInterval === null) return;
    clearInterval(this.PollInterval);
    this.PollInterval = null;
  }

  /**
   * Per-tick HP read. GTA's range is 0-200 with 100 as the alive floor;
   * a fully healthy character-column HP of 100 reads as 200 here, and
   * an HP=0 column reads as 100.
   *
   *   Healthy: emit when engine HP crosses below `100 + HpCriticalThreshold`.
   *   Non-Healthy: ped is server-clamped to `HpInjuredFloor + 100 = 105`.
   *                Any new lethal hit drops engine HP at or below 100
   *                (the alive floor) - that is the death-cascade signal.
   *                Emit so the server walks one slot down InjuryProgression.
   *                The server's `AdvancementCooldownMs` (10 s) absorbs the
   *                ragdoll-spike that follows the dead pose.
   */
  private PollHealth(): void {
    if (!this.IsSpawned) return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const Health = GetEntityHealth(Ped);
    if (this.CurrentStatus === 'Healthy') {
      if (Health > 100 + HpCriticalThreshold) return;
    } else {
      if (Health > 100) return;
    }
    const Now = Date.now();
    if (Now - this.LastEmitAt < 1000) return;
    this.LastEmitAt = Now;
    emitNet(NetEvents.InjuryHealthCritical);
    this.Log.Debug(`HealthCritical emitted - hp=${Health} status=${this.CurrentStatus}`);
  }

  // ── Authoritative HP / position application ─────────────────────────

  /**
   * Apply a server-sent ped state mutation. HP is in the 0-100
   * character-column range; the GTA native uses 0-200 with 100 as the
   * alive baseline, so we add the offset before SetEntityHealth.
   * Armour no longer rides this event - SET_PED_ARMOUR is
   * apiset-server and the Backend writes it directly. Teleport, when
   * supplied, uses SetEntityCoordsNoOffset with all flags false
   * (alive=false here means "not a ragdoll teleport" - the engine
   * accepts the move on a frozen or alive ped either way).
   */
  private ApplyPedState(
    Payload: NetEventPayloads[typeof NetEvents.InjuryApply],
  ): void {
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const Hp = Math.max(0, Math.min(100, Payload.HP));
    SetEntityHealth(Ped, Hp + 100);
    if (Payload.Teleport !== undefined) {
      SetEntityCoordsNoOffset(
        Ped,
        Payload.Teleport.X,
        Payload.Teleport.Y,
        Payload.Teleport.Z,
        false,
        false,
        false,
      );
      SetEntityHeading(Ped, Payload.Teleport.Heading);
    }
    this.Log.Debug(
      `ApplyPedState hp=${Hp}${Payload.Teleport !== undefined ? ' teleport' : ''}`,
    );
  }

  /**
   * Apply one server-instructed regen tick. The delta is relative so
   * it composes with damage taken while the instruction was in flight
   * (the drain tick's rationale, mirrored). Ceiling 200 is the
   * engine's full-health value; the non-Healthy guard drops ticks
   * that land mid-collapse so the server's injured-floor clamp stays
   * authoritative.
   */
  private ApplyRegenTick(
    Payload: NetEventPayloads[typeof NetEvents.InjuryRegenTick],
  ): void {
    const HpDelta = Number(Payload.HpDelta);
    if (!Number.isFinite(HpDelta) || HpDelta <= 0 || HpDelta > RegenMaxHpDelta) {
      this.Log.Warn(`RegenTick rejected - malformed HpDelta=${String(Payload.HpDelta)}`);
      return;
    }
    if (this.CurrentStatus !== 'Healthy') return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    SetEntityHealth(Ped, Math.min(200, GetEntityHealth(Ped) + HpDelta));
  }

  /**
   * Apply one withdrawal drain. The floor sits far above the injury
   * thresholds and is checked BEFORE applying - a ped that combat
   * already pushed below it skips the tick entirely rather than
   * being healed up to the floor by Math.max.
   */
  private ApplyWithdrawalTick(
    Payload: NetEventPayloads[typeof NetEvents.AddictionWithdrawalTick],
  ): void {
    const HpDelta = Number(Payload.HpDelta);
    if (!Number.isFinite(HpDelta) || HpDelta >= 0 || -HpDelta > WithdrawalMaxAbsHpDelta) {
      this.Log.Warn(`WithdrawalTick rejected - malformed HpDelta=${String(Payload.HpDelta)}`);
      return;
    }
    if (this.CurrentStatus !== 'Healthy') return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const EngineFloor = WithdrawalDrainFloorHp + 100;
    const Current = GetEntityHealth(Ped);
    if (Current <= EngineFloor) return;
    SetEntityHealth(Ped, Math.max(EngineFloor, Current + HpDelta));
  }

  // ── Incapacitated visual state ──────────────────────────────────────

  /**
   * Apply the downed state: ragdoll the ped and start suppressing the
   * controls a wounded character should not have.
   *
   * Driven by the server's replicated injury status, never by local HP -
   * a client deciding for itself when it is downed could simply decline.
   */
  private EnterIncapacitated(): void {
    this.StartSuppressionTick();
    setTimeout((): void => {
      // Re-check on the deferred path: if the server flipped us back
      // to Healthy in the 500 ms window (admin /arevive), do not
      // start the dead pose.
      if (this.CurrentStatus === 'Healthy') return;
      const TargetPed = PlayerPedId();
      if (TargetPed === 0) return;
      if (!HasAnimDictLoaded(DeadPoseDict)) {
        RequestAnimDict(DeadPoseDict);
        // Best-effort: even if the dict is not loaded yet TaskPlayAnim
        // is harmless. The suppression tick covers the WASTED cycle
        // until the engine catches up.
      }
      TaskPlayAnim(
        TargetPed,
        DeadPoseDict,
        DeadPoseClip,
        DeadPoseBlendIn,
        -DeadPoseBlendIn,
        -1,
        1,
        0,
        false,
        false,
        false,
      );
    }, DeadPoseStartDelayMs);
  }

  /** Restore normal control on revive, clearing ragdoll and suppression. */
  private ExitIncapacitated(): void {
    const Ped = PlayerPedId();
    if (Ped !== 0) {
      ClearPedTasksImmediately(Ped);
      this.ClearVisibleDamage(Ped);
    }
    this.StopSuppressionTick();
  }

  /**
   * Wipe accumulated ped visual damage on revival. Restoring HP does
   * NOT clear blood overlays, impact decals, wetness, or environmental
   * dirt in GTA - they persist on the model independent of health - so
   * a revived player would otherwise still look freshly shot. Called
   * from ExitIncapacitated, the single non-Healthy -> Healthy edge that
   * every revive path (/helpup, /arevive, the dying-while-Dead
   * auto-respawn) flips through. Deliberately does NOT touch ped
   * decorations (ClearPedDecorations) - that would strip tattoos / hair
   * owned by PedDressingService.
   */
  private ClearVisibleDamage(Ped: number): void {
    ClearPedBloodDamage(Ped);
    ResetPedVisibleDamage(Ped);
    ClearPedWetness(Ped);
    ClearPedEnvDirt(Ped);
  }

  // ── Suppression tick ────────────────────────────────────────────────

  /**
   * Begin per-frame control suppression.
   *
   * Must run every frame: the engine re-enables controls continuously, so
   * disabling them once has no lasting effect.
   */
  private StartSuppressionTick(): void {
    if (this.SuppressionTick !== null) return;
    this.SuppressionTick = setTick((): void => {
      // Always-on while incapacitated. Cheap natives; they each cost
      // less than 0.001 ms per call and an early-return on the server
      // status would race against the bag-change handler.
      DisableAutomaticRespawn(true);
      IgnoreNextRestart(true);
      PauseDeathArrestRestart(true);
      ThefeedHideThisFrame();
      HideHudComponentThisFrame(2);
      for (const Control of DisabledControls) {
        DisableControlAction(2, Control, true);
      }
    });
  }

  /** End control suppression, returning the ped to normal input. */
  private StopSuppressionTick(): void {
    if (this.SuppressionTick === null) return;
    clearTick(this.SuppressionTick);
    this.SuppressionTick = null;
  }
}

/**
 * Read the local player's replicated InjuryStatus bag value as a typed
 * union. Unknown values fall back to 'Healthy' so a malformed publish
 * never strands the client in a phantom dead pose.
 */
function ReadLocalInjuryStatus(): InjuryStatus {
  const Raw = LocalPlayer.state[NametagBagKeys.InjuryStatus];
  return NormaliseInjuryStatus(Raw);
}

/**
 * Coerce a replicated injury-status bag value to a known state,
 * defaulting to healthy - same absent-during-join reasoning as the
 * bleeding controller's equivalent.
 */
function NormaliseInjuryStatus(Raw: unknown): InjuryStatus {
  if (
    Raw === 'Healthy' ||
    Raw === 'Unconscious' ||
    Raw === 'BadlyWounded' ||
    Raw === 'Dead'
  ) {
    return Raw;
  }
  return 'Healthy';
}
