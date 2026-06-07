import { ChatFormatter, ChatRanges } from '@Shared/Chat/Index.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { InjuryStatus, BleedingStatus } from '@Shared/Constants/Character.js';
import {
  AcceptDeathWaitMs,
  AdvancementCooldownMs,
  HelpUpRangeMeters,
  HpHealthy,
  HpHelpedUp,
  HpInjuredFloor,
  HpRevived,
  InjuryNarration,
  InjuryProgression,
} from '@Shared/Constants/Injury.js';
import { Hospitals, type Hospital } from '@Shared/Constants/Hospitals.js';
import type { Vec3 } from '@Shared/Constants/AuthSkybox.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type {
  CharacterRuntime,
  CharacterRuntimeService,
} from '@/Services/CharacterRuntimeService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PositionValidatorService } from '@/Services/PositionValidatorService.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';

declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;

export type HelpUpResult =
  | { Ok: true; TargetName: string; IssuerName: string }
  | { Ok: false; Reason: string };

/**
 * Injury / death state machine. Single source of truth for moving a
 * character through Healthy -> Unconscious -> BadlyWounded -> Dead and
 * back out via /acceptdeath, /helpup, or /arevive.
 *
 * Every transition does five things in order:
 *
 *   1. Mutate the runtime via CharacterRuntimeService.SetInjuryStatus.
 *      That call writes the replicated state bag the client + nametag
 *      overlay read.
 *   2. Persist the row via CharacterRepository.SaveInjury so a server
 *      crash mid-session does not roll the player back.
 *   3. Clamp / set the ped HP server-side via SetEntityHealth (GTA
 *      offset: alive=100..200).
 *   4. Optionally snapshot the ped coords to the row so the body stays
 *      where it fell on relog (ragemp spawn-in-place pattern).
 *   5. Broadcast purple `/me` auto-narration at Say range + send the
 *      issuer-side toast.
 *
 * Cooldowns:
 *
 *   - LastAdvancement gates `AdvanceFromCriticalHit` so ragdoll-physics
 *     fall damage 1-2 s after the death animation does not cascade into
 *     another stage.
 *   - DeadTimestamps gates `/acceptdeath` so the 2-minute wait can not
 *     be bypassed by relogging (ApplyOnSpawn restamps on every
 *     spawn-while-injured).
 *
 * No active simulation: this service only reacts to events
 * (HealthCritical, command invocations, spawn). There is no bleed-out
 * timer; BleedingStatus is a discrete label that the revive paths reset
 * to NotBleeding and nothing else writes today.
 */
export class InjuryService {
  private readonly Log = Logger.New('Injury');
  /** Source -> wall-clock ms when the player first transitioned to non-Healthy. */
  private readonly DeadTimestamps = new Map<number, number>();
  /** Source -> wall-clock ms of the last state advancement (cascade cooldown). */
  private readonly LastAdvancement = new Map<number, number>();

  constructor(
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Characters: CharacterRepository,
    private readonly Broadcaster: ProximityBroadcaster,
    private readonly Chat: ChatService,
    private readonly Validator: PositionValidatorService,
  ) {
    on('playerDropped', (): void => {
      this.Evict(source);
    });
    this.Log.Debug('Handlers registered (playerDropped)');
  }

  /**
   * Entry point for the client HealthCritical signal. Walks the player
   * one slot down `InjuryProgression` (Healthy -> Unconscious, etc.),
   * unless the cascade cooldown is active or the player is already at
   * the terminal Dead slot (which just re-clamps HP and re-narrates).
   */
  async AdvanceFromCriticalHit(Src: number): Promise<void> {
    if (!this.IsSpawned(Src)) return;
    const Runtime = this.Runtimes.Get(Src);
    if (Runtime === null) return;

    const Now = Date.now();
    const Last = this.LastAdvancement.get(Src);
    if (Last !== undefined && Now - Last < AdvancementCooldownMs) {
      this.Log.Debug(
        `Cooldown skip - source=${Src} elapsed=${Now - Last}ms`,
      );
      return;
    }

    const CurrentIdx = InjuryProgression.indexOf(Runtime.InjuryStatus);
    const NextIdx = Math.min(CurrentIdx + 1, InjuryProgression.length - 1);
    const Next = InjuryProgression[NextIdx];
    if (Next === undefined) return;

    const Position = this.PedCoords(Src);
    await this.ApplyTransition(Src, Runtime, Next, Position);
  }

  /**
   * `/acceptdeath`. Available in any non-Healthy state. Refuses until
   * AcceptDeathWaitMs has elapsed since the first non-Healthy transition
   * for this Source (or the most recent spawn-while-injured restamp).
   * On success the player respawns at the nearest hospital with full
   * HP and the runtime resets to Healthy.
   *
   * `BypassWait` skips the 2-minute timer. The command-side gate
   * (Founder + AdminDuty, matching the /pm self-PM and /to self-target
   * Founder exceptions) decides whether to set it; the service only
   * trusts what the caller sends.
   */
  async AcceptDeath(
    Src: number,
    BypassWait: boolean = false,
  ): Promise<
    | { Ok: true; Hospital: Hospital }
    | { Ok: false; Reason: string }
    | { Ok: false; RemainingMs: number }
  > {
    if (!this.IsSpawned(Src)) {
      return { Ok: false, Reason: 'You must be in the world to accept death.' };
    }
    const Runtime = this.Runtimes.Get(Src);
    if (Runtime === null) {
      return { Ok: false, Reason: 'Your character is not loaded.' };
    }
    if (Runtime.InjuryStatus === 'Healthy') {
      return { Ok: false, Reason: 'You are not injured.' };
    }

    if (!BypassWait) {
      const Stamp = this.DeadTimestamps.get(Src);
      if (Stamp !== undefined) {
        const Elapsed = Date.now() - Stamp;
        if (Elapsed < AcceptDeathWaitMs) {
          return { Ok: false, RemainingMs: AcceptDeathWaitMs - Elapsed };
        }
      }
    }

    const From = this.PedCoords(Src) ?? {
      X: 0,
      Y: 0,
      Z: 0,
    };
    const Hospital = this.NearestHospital(From);

    this.Runtimes.SetInjuryStatus(Src, 'Healthy');
    this.Runtimes.SetBleedingStatus(Src, 'NotBleeding');
    this.EmitApply(Src, {
      HP: HpHealthy,
      AP: 0,
      Teleport: {
        X: Hospital.Coord.X,
        Y: Hospital.Coord.Y,
        Z: Hospital.Coord.Z,
        Heading: Hospital.Heading,
      },
    });

    // Reset the anti-teleport baseline so the validator does not see
    // the hospital warp as a hack delta and pin its "last sane" coord
    // at the death site. Without this, PersistAndDetachRuntime on the
    // next disconnect prefers the validator's death-site coords over
    // the actual hospital position and the player wakes up at their
    // grave on next login.
    this.Validator.SetServerOverride(Src, {
      X: Hospital.Coord.X,
      Y: Hospital.Coord.Y,
      Z: Hospital.Coord.Z,
      Heading: Hospital.Heading,
      World: Hospital.World,
    });

    this.DeadTimestamps.delete(Src);
    this.LastAdvancement.delete(Src);

    await this.SafeSave(Runtime.CharacterID, 'Healthy', 'NotBleeding', HpHealthy, {
      X: Hospital.Coord.X,
      Y: Hospital.Coord.Y,
      Z: Hospital.Coord.Z,
      Heading: Hospital.Heading,
      World: Hospital.World,
    });

    return { Ok: true, Hospital };
  }

  /**
   * `/helpup`. A bystander lifts an unconscious player back to half
   * health. Issuer must be Healthy themselves, the target must be
   * Unconscious (not BadlyWounded or Dead - those are EMS / `/arevive`
   * territory), and the two peds must be within HelpUpRangeMeters.
   * All three preconditions checked here so the command handler stays
   * a thin pass-through.
   */
  async HelpUp(Issuer: number, Target: number): Promise<HelpUpResult> {
    if (!this.IsSpawned(Issuer) || !this.IsSpawned(Target)) {
      return { Ok: false, Reason: 'Target is not in the world.' };
    }
    if (Issuer === Target) {
      return { Ok: false, Reason: 'You cannot help yourself up.' };
    }
    const IssuerRuntime = this.Runtimes.Get(Issuer);
    const TargetRuntime = this.Runtimes.Get(Target);
    if (IssuerRuntime === null || TargetRuntime === null) {
      return { Ok: false, Reason: 'Target is not in the world.' };
    }
    if (IssuerRuntime.InjuryStatus !== 'Healthy') {
      return {
        Ok: false,
        Reason: 'You cannot help anyone up. You are incapacitated.',
      };
    }
    if (TargetRuntime.InjuryStatus !== 'Unconscious') {
      return {
        Ok: false,
        Reason: '/helpup only works on unconscious players.',
      };
    }

    const IssuerPos = this.PedCoords(Issuer);
    const TargetPos = this.PedCoords(Target);
    if (IssuerPos === null || TargetPos === null) {
      return { Ok: false, Reason: 'Target is not in the world.' };
    }
    const Dx = IssuerPos.X - TargetPos.X;
    const Dy = IssuerPos.Y - TargetPos.Y;
    const Dz = IssuerPos.Z - TargetPos.Z;
    if (Dx * Dx + Dy * Dy + Dz * Dz > HelpUpRangeMeters * HelpUpRangeMeters) {
      return {
        Ok: false,
        Reason: 'Target is not close enough to help up.',
      };
    }

    this.Runtimes.SetInjuryStatus(Target, 'Healthy');
    this.Runtimes.SetBleedingStatus(Target, 'NotBleeding');
    this.EmitApply(Target, { HP: HpHelpedUp });

    this.DeadTimestamps.delete(Target);
    this.LastAdvancement.delete(Target);

    await this.SafeSave(
      TargetRuntime.CharacterID,
      'Healthy',
      'NotBleeding',
      HpHelpedUp,
    );

    const IssuerName = this.Broadcaster.DisplayName(Issuer) ?? 'Someone';
    const TargetName = this.Broadcaster.DisplayName(Target) ?? 'Someone';
    const Line = ChatFormatter.MeAction(IssuerName, `helps ${TargetName} up.`);
    this.Broadcaster.BroadcastInRange(Issuer, Line, ChatRanges.Say);

    return { Ok: true, IssuerName, TargetName };
  }

  /**
   * `/arevive`. Admin path - full restore irrespective of distance,
   * state, or target's wait clock. No IC narration; the caller is
   * expected to surface OOC `(( INFO: ... ))` toasts to issuer + target.
   */
  async AdminRevive(Target: number): Promise<boolean> {
    if (!this.IsSpawned(Target)) return false;
    const Runtime = this.Runtimes.Get(Target);
    if (Runtime === null) return false;

    this.Runtimes.SetInjuryStatus(Target, 'Healthy');
    this.Runtimes.SetBleedingStatus(Target, 'NotBleeding');
    this.EmitApply(Target, { HP: HpRevived, AP: 0 });

    this.DeadTimestamps.delete(Target);
    this.LastAdvancement.delete(Target);

    await this.SafeSave(
      Runtime.CharacterID,
      'Healthy',
      'NotBleeding',
      HpRevived,
    );
    return true;
  }

  /**
   * Called from CharacterController.SpawnInto right after
   * Runtimes.Attach. When the persisted row carried a non-Healthy
   * status, restamp the /acceptdeath wait clock so logging out for
   * 2 minutes wall-clock does not bypass the gate. The replicated
   * state bag was already written by Attach; the client's
   * AddStateBagChangeHandler fires on receipt and applies the dead
   * pose + combat lock without anything more from us.
   */
  ApplyOnSpawn(Src: number, Runtime: CharacterRuntime): void {
    if (Runtime.InjuryStatus === 'Healthy') return;
    this.DeadTimestamps.set(Src, Date.now());
    this.Log.Debug(
      `Relog-while-injured - source=${Src} status=${Runtime.InjuryStatus}; ` +
        `/acceptdeath clock restamped`,
    );
  }

  /**
   * Per-Source eviction. Cooldown and dead-timestamp maps are session
   * state; on disconnect they go. The persisted InjuryStatus on the
   * row stays exactly where the last SaveInjury left it, so a reconnect
   * picks up the same state through the normal spawn path.
   */
  Evict(Src: number): void {
    this.DeadTimestamps.delete(Src);
    this.LastAdvancement.delete(Src);
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Shared body for every "lethal hit landed" path. Clamps HP, mutates
   * the runtime (which writes the state bag), persists the row (with
   * the death-site position when supplied), stamps cooldowns, and
   * broadcasts the auto-narration + issuer toast.
   */
  private async ApplyTransition(
    Src: number,
    Runtime: CharacterRuntime,
    Next: InjuryStatus,
    Position: Vec3 | null,
  ): Promise<void> {
    this.EmitApply(Src, { HP: HpInjuredFloor });
    this.Runtimes.SetInjuryStatus(Src, Next);

    const Now = Date.now();
    this.LastAdvancement.set(Src, Now);
    if (Next !== 'Healthy' && !this.DeadTimestamps.has(Src)) {
      this.DeadTimestamps.set(Src, Now);
    }

    const PersistPosition =
      Position === null
        ? undefined
        : { X: Position.X, Y: Position.Y, Z: Position.Z };
    await this.SafeSave(
      Runtime.CharacterID,
      Next,
      Runtime.BleedingStatus,
      HpInjuredFloor,
      PersistPosition,
    );

    if (Next === 'Healthy') return;
    const NarrationBody = InjuryNarration[Next];
    if (NarrationBody !== undefined) {
      const Name = this.Broadcaster.DisplayName(Src) ?? 'Someone';
      const Line = ChatFormatter.MeAction(Name, NarrationBody);
      this.Broadcaster.BroadcastInRange(Src, Line, ChatRanges.Say);
    }

    const Toast = ToastForState(Next);
    if (Toast !== null) this.Chat.SendTo(Src, ChatFormatter.Warning(Toast));
  }

  private async SafeSave(
    CharacterID: string,
    InjuryStatus: InjuryStatus,
    BleedingStatus: BleedingStatus,
    HP: number,
    Position?: { X: number; Y: number; Z: number; Heading?: number; World?: number },
  ): Promise<void> {
    try {
      // Build the payload without an explicit `Position: undefined` -
      // the repository's exactOptionalPropertyTypes check rejects
      // undefined-assigned optional fields.
      const Payload =
        Position === undefined
          ? { InjuryStatus, BleedingStatus, HP }
          : { InjuryStatus, BleedingStatus, HP, Position };
      await this.Characters.SaveInjury(CharacterID, Payload);
    } catch (Err: unknown) {
      this.Log.Error(`SaveInjury failed - character=${CharacterID}`, {
        Err: String(Err),
      });
    }
  }

  private IsSpawned(Src: number): boolean {
    return this.State.Get(Src)?.Phase === 'Spawned';
  }

  private PedCoords(Src: number): Vec3 | null {
    try {
      const Ped = GetPlayerPed(String(Src));
      if (Ped === 0) return null;
      const Coords = GetEntityCoords(Ped);
      const X = Number(Coords[0]);
      const Y = Number(Coords[1]);
      const Z = Number(Coords[2]);
      if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) {
        return null;
      }
      return { X, Y, Z };
    } catch (Err: unknown) {
      this.Log.Warn(`PedCoords failed source=${Src}`, { Err: String(Err) });
      return null;
    }
  }

  /**
   * Ask the target client to apply an authoritative HP / armour /
   * position state via its local InjuryController. The Set* natives
   * the server would otherwise call are client-only in FXServer
   * (Mono raises ReferenceError when invoked server-side); this is
   * the round-trip path. The state-bag flip rides separately on
   * Runtimes.SetInjuryStatus and the bag handler activates the visual
   * pose / suppression tick - this event covers only the engine HP +
   * world-position writes.
   */
  private EmitApply(
    Src: number,
    Payload: NetEventPayloads[typeof NetEvents.InjuryApply],
  ): void {
    try {
      emitNet(NetEvents.InjuryApply, Src, Payload);
    } catch (Err: unknown) {
      this.Log.Warn(`EmitApply failed source=${Src}`, { Err: String(Err) });
    }
  }

  private NearestHospital(From: Vec3): Hospital {
    let Best = Hospitals[0];
    let BestSq = Number.POSITIVE_INFINITY;
    for (const H of Hospitals) {
      const Dx = H.Coord.X - From.X;
      const Dy = H.Coord.Y - From.Y;
      const Dz = H.Coord.Z - From.Z;
      const Sq = Dx * Dx + Dy * Dy + Dz * Dz;
      if (Sq < BestSq) {
        BestSq = Sq;
        Best = H;
      }
    }
    return Best as Hospital;
  }
}

/**
 * Issuer-side toast text per non-Healthy state. Sender-only, not
 * broadcast - this is the personal heads-up the auto-narration's purple
 * `/me` doesn't carry (the narration goes to everyone in range; the
 * toast tells the *victim* what their situation is and what they can do
 * about it). Wrapped in ChatFormatter.Warning by the caller.
 */
function ToastForState(Status: InjuryStatus): string | null {
  switch (Status) {
    case 'Unconscious':
      return 'You have been knocked unconscious. /acceptdeath available in 120 second(s).';
    case 'BadlyWounded':
      return 'You are badly wounded. /acceptdeath available in 120 second(s).';
    case 'Dead':
      return 'You have died. /acceptdeath now to respawn at the nearest hospital.';
    default:
      return null;
  }
}
