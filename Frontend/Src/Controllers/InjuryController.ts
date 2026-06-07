import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import {
  HealthPollIntervalMs,
  HpCriticalThreshold,
} from '@Shared/Constants/Injury.js';
import type { InjuryStatus } from '@Shared/Constants/Character.js';
import { Logger } from '@/Util/Logger.js';

declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
declare function setTick(Callback: () => void): number;
declare function clearTick(Handle: number): void;
declare function PlayerPedId(): number;
declare function PlayerId(): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetEntityHealth(Entity: number): number;
declare function SetEntityHealth(Entity: number, Health: number): void;
declare function SetPedArmour(Ped: number, Amount: number): void;
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
declare function SetEntityInvincible(Entity: number, Invincible: boolean): void;
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

const DeadPoseDict = 'dead';
const DeadPoseClip = 'dead_a';
const DeadPoseBlendIn = 8.0;
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

  private StartHealthPoll(): void {
    if (this.PollInterval !== null) return;
    this.PollInterval = setInterval((): void => {
      this.PollHealth();
    }, HealthPollIntervalMs);
  }

  private StopHealthPoll(): void {
    if (this.PollInterval === null) return;
    clearInterval(this.PollInterval);
    this.PollInterval = null;
  }

  /**
   * Per-tick HP read. GTA's range is 0-200 with 100 as the alive floor;
   * a fully healthy character-column HP of 100 reads as 200 here, and
   * an HP=0 column reads as 100. We watch for the engine value crossing
   * below `100 + HpCriticalThreshold` while still server-side Healthy.
   * Anyone already non-Healthy is held at the HpInjuredFloor by the
   * server's clamp; their poll is a no-op.
   */
  private PollHealth(): void {
    if (!this.IsSpawned) return;
    if (this.CurrentStatus !== 'Healthy') return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const Health = GetEntityHealth(Ped);
    if (Health > 100 + HpCriticalThreshold) return;
    if (Health <= 100) {
      // Already at or below the alive floor - the engine is one frame
      // away from firing native death. Same emit either way; the server
      // clamps to floor and advances.
    }
    const Now = Date.now();
    if (Now - this.LastEmitAt < 1000) return;
    this.LastEmitAt = Now;
    emitNet(NetEvents.InjuryHealthCritical);
    this.Log.Debug(`HealthCritical emitted - hp=${Health}`);
  }

  // ── Authoritative HP / position application ─────────────────────────

  /**
   * Apply a server-sent ped state mutation. HP is in the 0-100
   * character-column range; the GTA native uses 0-200 with 100 as the
   * alive baseline, so we add the offset before SetEntityHealth. AP
   * maps 1:1. Teleport, when supplied, uses SetEntityCoordsNoOffset
   * with all flags false (alive=false here means "not a ragdoll
   * teleport" - the engine accepts the move on a frozen or alive ped
   * either way).
   */
  private ApplyPedState(
    Payload: NetEventPayloads[typeof NetEvents.InjuryApply],
  ): void {
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const Hp = Math.max(0, Math.min(100, Payload.HP));
    SetEntityHealth(Ped, Hp + 100);
    if (Payload.AP !== undefined) {
      SetPedArmour(Ped, Math.max(0, Math.min(100, Payload.AP)));
    }
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

  // ── Incapacitated visual state ──────────────────────────────────────

  private EnterIncapacitated(): void {
    const Ped = PlayerPedId();
    if (Ped !== 0) SetEntityInvincible(Ped, true);
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
        // is harmless. The suppression tick and invincibility cover us
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

  private ExitIncapacitated(): void {
    const Ped = PlayerPedId();
    if (Ped !== 0) {
      ClearPedTasksImmediately(Ped);
      SetEntityInvincible(Ped, false);
    }
    this.StopSuppressionTick();
  }

  // ── Suppression tick ────────────────────────────────────────────────

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
