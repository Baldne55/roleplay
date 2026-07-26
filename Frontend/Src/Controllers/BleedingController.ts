import {
  BleedingMaxAbsHpDelta,
  BleedingMovement,
  BleedingStatusBagKey,
} from '@Shared/Constants/Bleeding.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { ClientEvents } from '@Shared/Events/ClientEvents.js';
import type { BleedingStatus } from '@Shared/Constants/Character.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function setTick(Callback: () => void): number;
declare function clearTick(Handle: number): void;
declare function PlayerPedId(): number;
declare function PlayerId(): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetEntityHealth(Entity: number): number;
declare function SetEntityHealth(Entity: number, Health: number): void;
declare function DisableControlAction(PadIndex: number, Control: number, Disable: boolean): void;
declare function SetPedMoveRateOverride(Ped: number, Rate: number): void;
declare function RequestAnimSet(AnimSet: string): void;
declare function HasAnimSetLoaded(AnimSet: string): boolean;
declare function SetPedMovementClipset(Ped: number, ClipSet: string, TransitionSpeed: number): void;
declare function ResetPedMovementClipset(Ped: number, TransitionSpeed: number): void;
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

/** Blend time (seconds) for movement-clipset apply / reset transitions. */
const ClipsetBlendSeconds = 0.25;
/** Anim-set stream retry cadence; mirrors the ground-drop prop loader. */
const ClipsetLoadRetryDelayMs = 100;
/** Retry budget before giving up on a clipset stream (40 x 100 ms = 4 s). */
const ClipsetLoadMaxAttempts = 40;
/** INPUT_SPRINT / INPUT_JUMP control IDs on pad 0. */
const ControlSprint = 21;
const ControlJump = 22;

/**
 * Client half of the bleeding surface. Three jobs:
 *
 *   1. Movement consequences, driven entirely by the replicated
 *      `Roleplay:BleedingStatus` state bag. Each tier maps to a
 *      BleedingMovement profile: a movement clipset (the injured walk)
 *      plus per-frame sprint / jump locks and a move-rate slowdown.
 *      The escalation state machine itself lives server-side in
 *      BleedingService - this side only renders its published tier.
 *
 *   2. Clipset re-application after the spawn dressing pass. A
 *      SetPlayerModel swap silently clears per-ped movement clipsets,
 *      so the clipset path is deferred until the local
 *      SpawnDressingComplete event confirms the freshly swapped ped is
 *      fully dressed - applying earlier would be wiped by the swap.
 *
 *   3. Drain ticks. The server has no SET_ENTITY_HEALTH apiset variant,
 *      so each bleed-out drain arrives as `Bleeding:DrainTick` carrying
 *      a column-range HP *delta* the local ped applies against its live
 *      engine HP - a delta composes with concurrent gunfire where an
 *      absolute write would resurrect damage dealt in flight.
 *
 * Lifecycle: gated on `IsSpawned` (CharacterSpawned -> on,
 * SessionReturnToSelect / SessionReturnToAuth -> off + full movement
 * reset). Mirrors the InjuryController gate.
 */
export class BleedingController {
  private readonly Log = Logger.New('Bleeding');

  private IsSpawned = false;
  /**
   * Cached server-side BleedingStatus. Tracked locally instead of
   * re-reading `LocalPlayer.state` on every tick because the bag read
   * surfaces unknown-shape data and we want a stable typed value.
   * Updated by the state-bag handler on every server flip + on
   * CharacterSpawned for the initial value.
   */
  private CurrentTier: BleedingStatus = 'NotBleeding';
  /**
   * True once SpawnDressingComplete has fired for the current spawn.
   * Clipset application is held until then - the SetPlayerModel swap
   * inside SpawnIntoWorld clears per-ped clipsets, so anything applied
   * earlier is silently lost.
   */
  private DressingDone = false;
  /**
   * Movement clipset currently applied to the ped, null when the engine
   * default is in effect. Skips redundant re-applies on tier flips that
   * share a clipset (Medium <-> Heavy) and tells the reset path whether
   * a ResetPedMovementClipset is owed. Cleared on every dressing pass
   * because the model swap wiped the engine-side state regardless.
   */
  private AppliedClipset: string | null = null;
  /** Active setTick handle for the impairment loop, null when not running. */
  private ImpairmentTick: number | null = null;

  constructor() {
    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
      // The state-bag may already carry the persisted tier by the time
      // CharacterSpawned lands - the server writes it before the spawn
      // event. Sync the cached value and start the impairment locks;
      // the clipset itself waits for the dressing signal (the model
      // swap that follows would clear it anyway).
      this.CurrentTier = ReadLocalBleedingStatus();
      this.ApplyMovementProfile();
    });

    // LOCAL event from SpawnService (same-client emit/on, never
    // networked): the freshly swapped ped is fully dressed. Re-apply
    // the clipset the SetPlayerModel swap cleared.
    on(ClientEvents.SpawnDressingComplete, (): void => {
      if (!this.IsSpawned) return;
      this.DressingDone = true;
      this.AppliedClipset = null;
      this.ApplyMovementProfile();
    });

    onNet(
      NetEvents.BleedingDrainTick,
      (Payload: NetEventPayloads[typeof NetEvents.BleedingDrainTick]): void => {
        if (!this.IsSpawned) return;
        this.ApplyDrainTick(Payload);
      },
    );

    const ReturnHandler = (): void => {
      this.IsSpawned = false;
      this.DressingDone = false;
      this.CurrentTier = 'NotBleeding';
      this.StopImpairmentTick();
      const Ped = PlayerPedId();
      if (Ped !== 0) {
        ResetPedMovementClipset(Ped, ClipsetBlendSeconds);
      }
      this.AppliedClipset = null;
    };
    onNet(NetEvents.SessionReturnToSelect, ReturnHandler);
    onNet(NetEvents.SessionReturnToAuth, ReturnHandler);

    // FX state bags publish under `player:<serverId>`. Filter on the
    // BleedingStatus key only; check the bag name inside the handler
    // (same idiom as the InjuryController's InjuryStatus listener).
    AddStateBagChangeHandler(
      BleedingStatusBagKey,
      '',
      (BagName, _Key, Value): void => {
        if (!this.IsSpawned) return;
        const SelfBag = `player:${GetPlayerServerId(PlayerId())}`;
        if (BagName !== SelfBag) return;
        const Next = NormaliseBleedingStatus(Value);
        if (Next === this.CurrentTier) return;
        const Prev = this.CurrentTier;
        this.CurrentTier = Next;
        this.ApplyMovementProfile();
        this.Log.Debug(`BleedingStatus ${Prev} -> ${Next}`);
      },
    );

    this.Log.Debug(
      'Handlers registered (CharacterSpawned, SpawnDressingComplete, DrainTick, SessionReturnTo*, BleedingStatus bag)',
    );
  }

  // ── Movement profile ────────────────────────────────────────────────

  /**
   * Render the current tier's BleedingMovement profile onto the ped.
   * Clipset path is gated on the dressing signal (per-ped clipsets do
   * not survive the SetPlayerModel swap); the impairment tick runs only
   * while the profile actually restricts something, so the controller
   * costs nothing per frame at NotBleeding / LightBleeding.
   */
  private ApplyMovementProfile(): void {
    const Profile = BleedingMovement[this.CurrentTier];

    if (Profile.Clipset !== null) {
      if (this.DressingDone && this.AppliedClipset !== Profile.Clipset) {
        this.ApplyClipsetWhenLoaded(Profile.Clipset, 0);
      }
    } else if (this.AppliedClipset !== null) {
      const Ped = PlayerPedId();
      if (Ped !== 0) {
        ResetPedMovementClipset(Ped, ClipsetBlendSeconds);
      }
      this.AppliedClipset = null;
    }

    const HasRestriction =
      Profile.DisableSprint || Profile.DisableJump || Profile.MoveRateOverride !== null;
    if (HasRestriction) {
      this.StartImpairmentTick();
    } else {
      this.StopImpairmentTick();
    }
  }

  /**
   * Stream the anim set, then apply it as the movement clipset. Bounded
   * retry mirroring the ground-drop prop loader: 100 ms cadence, 40
   * attempts, then give up with a warning (the impairment tick still
   * carries the gameplay restrictions - only the walk style is lost).
   * Each attempt re-checks the live tier so a stale in-flight load
   * never stomps a profile that changed mid-stream.
   */
  private ApplyClipsetWhenLoaded(Clipset: string, Attempt: number): void {
    if (!this.IsSpawned || !this.DressingDone) return;
    if (BleedingMovement[this.CurrentTier].Clipset !== Clipset) return;
    if (Attempt > ClipsetLoadMaxAttempts) {
      this.Log.Warn(`Movement clipset load timed out clipset=${Clipset}`);
      return;
    }
    if (!HasAnimSetLoaded(Clipset)) {
      RequestAnimSet(Clipset);
      setTimeout((): void => this.ApplyClipsetWhenLoaded(Clipset, Attempt + 1), ClipsetLoadRetryDelayMs);
      return;
    }
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    SetPedMovementClipset(Ped, Clipset, ClipsetBlendSeconds);
    this.AppliedClipset = Clipset;
    this.Log.Debug(`Movement clipset applied clipset=${Clipset} attempts=${Attempt}`);
  }

  // ── Impairment tick ─────────────────────────────────────────────────

  /**
   * Begin the bleeding impairment loop - the stumbles and camera sway
   * that scale with the replicated bleeding tier. Per-frame for the same
   * reason as injury suppression: engine state resets continuously.
   */
  private StartImpairmentTick(): void {
    if (this.ImpairmentTick !== null) return;
    this.ImpairmentTick = setTick((): void => {
      const Profile = BleedingMovement[this.CurrentTier];
      if (Profile.DisableSprint) DisableControlAction(0, ControlSprint, true);
      if (Profile.DisableJump) DisableControlAction(0, ControlJump, true);
      if (Profile.MoveRateOverride !== null) {
        // SetPedMoveRateOverride resets to 1.0 every frame inside the
        // engine, so it must be re-issued per tick - which also means
        // simply stopping this tick restores the default rate.
        const Ped = PlayerPedId();
        if (Ped !== 0) SetPedMoveRateOverride(Ped, Profile.MoveRateOverride);
      }
    });
  }

  /** End the impairment loop when bleeding clears. */
  private StopImpairmentTick(): void {
    if (this.ImpairmentTick === null) return;
    clearTick(this.ImpairmentTick);
    this.ImpairmentTick = null;
  }

  // ── Drain tick ──────────────────────────────────────────────────────

  /**
   * Apply one server-instructed bleed-out drain against the live engine
   * HP. Delta-not-absolute by design: SET_ENTITY_HEALTH has no server
   * apiset variant, and an absolute target computed server-side would
   * race concurrent gunfire in a read-modify-write window.
   *
   * Floor 101 mirrors the consumable path's column-1 floor (engine HP =
   * column + 100; 100 is the engine's alive floor). The injury system's
   * HealthCritical machinery fires at engine HP <= 110, long before the
   * floor matters - it exists so a drain tick alone can never push the
   * ped through the death cascade.
   *
   * The InjuryStatus bag guard drops ticks that land mid-collapse: once
   * the player is non-Healthy the server clamps engine HP to the
   * injured floor, and an in-flight drain tick must not fight that
   * clamp.
   */
  private ApplyDrainTick(
    Payload: NetEventPayloads[typeof NetEvents.BleedingDrainTick],
  ): void {
    const HpDelta = Number(Payload.HpDelta);
    if (!Number.isFinite(HpDelta) || Math.abs(HpDelta) > BleedingMaxAbsHpDelta) {
      this.Log.Warn(`DrainTick rejected - malformed HpDelta=${String(Payload.HpDelta)}`);
      return;
    }
    if (LocalPlayer.state[NametagBagKeys.InjuryStatus] !== 'Healthy') return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    SetEntityHealth(Ped, Math.max(101, GetEntityHealth(Ped) + HpDelta));
  }
}

/**
 * Read the local player's replicated BleedingStatus bag value as a
 * typed union. Unknown values fall back to 'NotBleeding' so a malformed
 * publish never strands the client in a phantom impairment.
 */
function ReadLocalBleedingStatus(): BleedingStatus {
  const Raw = LocalPlayer.state[BleedingStatusBagKey];
  return NormaliseBleedingStatus(Raw);
}

/**
 * Coerce a replicated bleeding-status bag value to a known tier,
 * defaulting to the healthy state.
 *
 * The bag is server-written, but the value can legitimately be absent
 * mid-join before the first replication lands - so an unknown value means
 * "not bleeding yet", never an error.
 */
function NormaliseBleedingStatus(Raw: unknown): BleedingStatus {
  if (
    Raw === 'NotBleeding' ||
    Raw === 'LightBleeding' ||
    Raw === 'MediumBleeding' ||
    Raw === 'HeavyBleeding'
  ) {
    return Raw;
  }
  return 'NotBleeding';
}
