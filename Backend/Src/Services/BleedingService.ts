import { ChatFormatter } from '@Shared/Chat/Index.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { BleedingStatus } from '@Shared/Constants/Character.js';
import {
  BleedingDrainFloorHp,
  BleedingDrainHpPerTick,
  BleedingDrainIntervalMs,
  BleedingDripIntervalMs,
  BleedingEscalationCooldownMs,
  BleedingHitConfirmDelayMs,
  BleedingLoopIntervalMs,
  BleedingProgression,
  BleedingReliefToastSlowed,
  BleedingReliefToastStopped,
  BleedingStumbleDurationMs,
  BleedingStumbleIntervalMs,
  BleedingToast,
  BloodSplatItemTypeID,
  BloodSplatMaxAgeMs,
  BloodSplatMaxLivePerCharacter,
  BloodSplatMinSpacingMeters,
  BloodSplatSweepIntervalMs,
  DoesWeaponCauseBleeding,
} from '@Shared/Constants/Bleeding.js';
import type { Vec3 } from '@Shared/Constants/AuthSkybox.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type {
  CharacterRuntime,
  CharacterRuntimeService,
} from '@/Services/CharacterRuntimeService.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { AnticheatScannerService } from '@/Services/AnticheatScannerService.js';
import type { ChatService } from '@/Services/ChatService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetEntityHealth(Entity: number): number;
declare function GetPedArmour(Ped: number): number;
declare function GetVehiclePedIsIn(Ped: number, LastVehicle: boolean): number;
declare function SetPedToRagdoll(
  Ped: number,
  MinTimeMs: number,
  MaxTimeMs: number,
  RagdollType: number,
  P4: boolean,
  P5: boolean,
  P6: boolean,
): boolean;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Session-scoped timers and evidence bookkeeping for one bleeding
 * Source. All wall-clock stamps lazily initialise on the first
 * scheduler pass that observes the Source bleeding, so the first drip /
 * drain / stumble lands one full interval after escalation rather than
 * instantly.
 */
interface BleedingEntry {
  /** Wall-clock ms of the last blood-splat drop (or skip-restamp). */
  LastDripAt: number | null;
  /** Wall-clock ms of the last HP-drain tick. */
  LastDrainAt: number | null;
  /**
   * Wall-clock ms of the last drain delta that actually went out over
   * the wire (the floor pre-check can consume an elapsed interval
   * without emitting, so this is distinct from LastDrainAt). Read when
   * a hit confirm arms: a drop this fresh may not have replicated into
   * the baseline sample yet, so it seeds the confirm drain discount.
   * Deliberately NOT cleared by ResetStamps - it tracks replication
   * physics, not wound state, and a drop emitted just before relief
   * closed the wound is still in flight.
   */
  LastDrainEmitAt: number | null;
  /** Wall-clock ms of the last stumble evaluation. */
  LastStumbleAt: number | null;
  /** Coords of this Source's previous splat (spacing gate). */
  LastSplatCoord: Vec3 | null;
  /**
   * Live splat DropIDs in drop order, oldest first. Bounded by
   * BloodSplatMaxLivePerCharacter - overflow recycles the head via
   * RemoveGroundDropBySystem. Survives a return to NotBleeding (the
   * splats stay in the world, so the cap must keep counting them) and
   * dies with the session on Evict; orphaned splats then age out via
   * the TTL sweep.
   */
  SplatRing: string[];
}

/**
 * Bleeding state machine. Owns the wound tier
 * (NotBleeding -> LightBleeding -> MediumBleeding -> HeavyBleeding),
 * its escalation from validated weapon hits, and the three recurring
 * consequences of an untreated wound: a blood-splat evidence trail, a
 * slow HP drain, and a periodic stumble. Sits beside InjuryService, not
 * inside it - InjuryStatus answers "can this character act at all",
 * BleedingStatus answers "is this character losing blood while acting".
 *
 * Escalation is CONFIRM-THEN-ESCALATE: a qualifying weaponDamageEvent
 * samples combined HP + armour, waits BleedingHitConfirmDelayMs, and
 * re-samples. Only a confirmed combined drop of at least 1 advances the
 * tier - so blanks, fully-absorbed hits, and spoofed damage events
 * never open a wound, and a multi-pellet trigger pull coalesces into a
 * single escalation. The service's own drain is discounted from that
 * comparison: every sanctioned drop emitted while a confirm is pending
 * (or still in flight when it arms) raises the required drop
 * one-for-one, so an already-bleeding victim's drain tick can never be
 * the combined movement that confirms a zero-damage hit. A further
 * BleedingEscalationCooldownMs gate keeps a sustained burst from
 * walking the victim straight to HeavyBleeding.
 *
 * Every tier transition does three things in order: mutate the runtime
 * via CharacterRuntimeService.SetBleedingStatus (which writes the
 * replicated status bag the client movement layer reads), persist the
 * row via CharacterRepository.SaveBleeding (crash-safe, same rationale
 * as SaveInjury), and toast the victim.
 *
 * One 1 s scheduler interval drives every per-player drip / drain /
 * stumble timer (BleedingLoopIntervalMs comfortably resolves the
 * fastest cadence, 3 s) rather than a timer per wound. The HP drain is
 * delivered as a relative HpDelta the client applies against its live
 * engine HP - SET_ENTITY_HEALTH has no apiset-server variant and an
 * absolute write computed here would race concurrent gunfire. Each
 * sanctioned drop is also registered with the anti-cheat scanner via
 * Scanner.NoteServerHpAdjustment, which folds it into an open
 * GodModeHealth hit-window baseline only once the replicated value
 * shows the drop landed; without that registration the drain would
 * lower combined HP below the baseline and silently refute the window,
 * masking actual god-moders the moment they start bleeding.
 */
export class BleedingService {
  private readonly Log = Logger.New('Bleeding');
  /** Source -> session timers + splat bookkeeping. */
  private readonly Entries = new Map<number, BleedingEntry>();
  /** Source -> wall-clock ms of the last tier escalation (burst cooldown). */
  private readonly LastEscalationAt = new Map<number, number>();
  /** Source -> armed confirm-delay timeout (one in flight per Source). */
  private readonly PendingConfirms = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Source -> combined HP the drain sanctioned while that Source's
   * confirm delay was pending (plus the seed for a drop still in flight
   * when it armed). ConfirmAndEscalate raises its required combined
   * drop by this amount, so the wound's own drain can never be the
   * movement that confirms a zero-damage (spoofed or fully-absorbed)
   * hit. Lifecycle mirrors PendingConfirms: seeded on arm, consumed on
   * resolve, dies on Evict.
   */
  private readonly ConfirmDrainDiscounts = new Map<number, number>();
  /**
   * Upper bound on how long a client-applied drain drop can take to
   * replicate back into the server-side GetEntityHealth read. A drain
   * emitted this recently before a confirm arms may be absent from the
   * baseline sample yet present in the re-sample, so it is discounted
   * as well. The conservatism only ever fails safe: worst case an
   * honest 1-damage hit inside this margin needs a follow-up hit to
   * confirm, never the reverse.
   */
  private readonly DrainReplicationSettleMs = 1_000;
  /** Active scheduler interval handle, null until Start(). */
  private LoopInterval: ReturnType<typeof setInterval> | null = null;
  /** Active splat TTL sweep handle, null until Start(). */
  private SweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Characters: CharacterRepository,
    private readonly Inventory: InventoryService,
    private readonly Scanner: AnticheatScannerService,
    private readonly Chat: ChatService,
  ) {}

  /**
   * Arm the two recurring loops: the 1 s scheduler that walks every
   * Spawned bleeder's drip / drain / stumble timers, and the slow TTL
   * sweep that ages expired blood splats out of the world (covers
   * splats orphaned by disconnects, whose ring bookkeeping died with
   * the session).
   */
  Start(): void {
    if (this.LoopInterval !== null) return;
    this.LoopInterval = setInterval((): void => {
      this.TickSpawned();
    }, BleedingLoopIntervalMs);
    this.SweepInterval = setInterval((): void => {
      void this.SweepSplats().catch((Err: unknown) => {
        this.Log.Error('Splat TTL sweep rejected', { Err: String(Err) });
      });
    }, BloodSplatSweepIntervalMs);
    this.Log.Info(
      `Scheduler armed (loop=${BleedingLoopIntervalMs}ms splatSweep=${BloodSplatSweepIntervalMs}ms)`,
    );
  }

  /**
   * Entry point from the validated weaponDamageEvent path. Filters down
   * to hits that can plausibly open a wound (victim Spawned with a
   * runtime, bleeding-capable weapon, burst cooldown idle, no confirm
   * already in flight), then arms the confirm-then-escalate delay:
   * sample combined HP + armour now, re-sample after
   * BleedingHitConfirmDelayMs, and escalate only if the combined value
   * actually fell. Both natives are apiset-server reads over OneSync
   * replication, so no client round-trip is involved.
   *
   * Arming also seeds the drain discount: a drain drop emitted within
   * DrainReplicationSettleMs of this sample may still be in flight and
   * would otherwise surface inside the confirm window as combined
   * movement the hit never caused.
   *
   * HitComponent is carried into the escalation debug line for staff
   * forensics but drives no logic: the event delivers raw component
   * ids and we deliberately keep no bone -> body-part mapping, so any
   * "headshot bleeds more" rule would be built on unvouched numerology.
   */
  OnHit(Victim: number, WeaponHash: number, HitComponent: number | null): void {
    if (!this.IsSpawned(Victim)) return;
    if (this.Runtimes.Get(Victim) === null) return;
    if (!DoesWeaponCauseBleeding(WeaponHash)) return;

    const Now = Date.now();
    const LastEscalation = this.LastEscalationAt.get(Victim);
    if (LastEscalation !== undefined && Now - LastEscalation < BleedingEscalationCooldownMs) {
      return;
    }
    if (this.PendingConfirms.has(Victim)) return;

    const Ped = this.Ped(Victim);
    if (Ped === 0) return;
    const BaselineCombined = GetEntityHealth(Ped) + GetPedArmour(Ped);

    const LastDrainEmitAt = this.Entries.get(Victim)?.LastDrainEmitAt ?? null;
    if (LastDrainEmitAt !== null && Now - LastDrainEmitAt < this.DrainReplicationSettleMs) {
      this.ConfirmDrainDiscounts.set(Victim, BleedingDrainHpPerTick);
    }

    const Handle = setTimeout((): void => {
      this.PendingConfirms.delete(Victim);
      const DrainDiscount = this.ConfirmDrainDiscounts.get(Victim) ?? 0;
      this.ConfirmDrainDiscounts.delete(Victim);
      void this.ConfirmAndEscalate(
        Victim,
        WeaponHash,
        HitComponent,
        BaselineCombined,
        DrainDiscount,
      ).catch((Err: unknown) => {
        this.Log.Error(`Hit confirm rejected for victim=${Victim}`, { Err: String(Err) });
      });
    }, BleedingHitConfirmDelayMs);
    this.PendingConfirms.set(Victim, Handle);
  }

  /**
   * Consumable relief path (bandage = StepDown, medkit = Clear). Walks
   * the tier one slot toward NotBleeding or jumps straight there, then
   * persists and toasts: "stopped" when the wound is fully closed,
   * "slows" when a lighter tier remains. Relief is best-effort: the
   * consumable applies its health effects regardless, and the relief
   * half silently no-ops for sources without a runtime or already at
   * NotBleeding.
   */
  async ApplyRelief(Source: number, Relief: 'StepDown' | 'Clear'): Promise<void> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return;
    const From = Runtime.BleedingStatus;
    if (From === 'NotBleeding') return;

    let Target: BleedingStatus = 'NotBleeding';
    if (Relief === 'StepDown') {
      const CurrentIdx = BleedingProgression.indexOf(From);
      Target = BleedingProgression[Math.max(0, CurrentIdx - 1)] ?? 'NotBleeding';
    }

    await this.ApplyTierChange(Source, Runtime, Target);
    const Toast =
      Target === 'NotBleeding' ? BleedingReliefToastStopped : BleedingReliefToastSlowed;
    this.Chat.SendTo(Source, ChatFormatter.Info(Toast));
    this.Log.Debug(`Relief - source=${Source} relief=${Relief} from=${From} to=${Target}`);
  }

  /**
   * Admin path (/asetbleeding) - explicit tier write, no toast (the
   * command layer surfaces its own OOC confirmation to the issuer).
   * Returns false when the Source has no attached runtime so the
   * command can report the failure instead of silently no-opping.
   */
  async SetTier(Source: number, Tier: BleedingStatus): Promise<boolean> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return false;
    await this.ApplyTierChange(Source, Runtime, Tier);
    this.Log.Debug(`Admin tier set - source=${Source} tier=${Tier}`);
    return true;
  }

  /**
   * Per-Source eviction. Timers, cooldowns, and the splat ring are
   * session state; on disconnect they go (the world splats themselves
   * persist as ground drops until the TTL sweep collects them). The
   * persisted BleedingStatus on the row stays where the last
   * SaveBleeding left it, so a reconnect resumes the same tier through
   * the normal spawn path.
   */
  Evict(Src: number): void {
    const Pending = this.PendingConfirms.get(Src);
    if (Pending !== undefined) {
      clearTimeout(Pending);
      this.PendingConfirms.delete(Src);
    }
    this.ConfirmDrainDiscounts.delete(Src);
    this.Entries.delete(Src);
    this.LastEscalationAt.delete(Src);
  }

  // ── Escalation internals ────────────────────────────────────────────

  /**
   * Second half of confirm-then-escalate. Re-validates the session,
   * re-samples combined HP + armour, and advances one slot along
   * BleedingProgression when the hit demonstrably cost the victim at
   * least 1 combined point BEYOND the drain the service itself
   * sanctioned around the window (DrainDiscount) - drops this service
   * instructed are not evidence the hit landed. A victim already at
   * HeavyBleeding stays there - the confirmed wound still stamps the
   * burst cooldown, but nothing is written and no toast is sent because
   * the tier did not change.
   */
  private async ConfirmAndEscalate(
    Victim: number,
    WeaponHash: number,
    HitComponent: number | null,
    BaselineCombined: number,
    DrainDiscount: number,
  ): Promise<void> {
    if (!this.IsSpawned(Victim)) return;
    const Runtime = this.Runtimes.Get(Victim);
    if (Runtime === null) return;
    const Ped = this.Ped(Victim);
    if (Ped === 0) return;

    const CurrentCombined = GetEntityHealth(Ped) + GetPedArmour(Ped);
    if (BaselineCombined - CurrentCombined < 1 + DrainDiscount) return;

    this.LastEscalationAt.set(Victim, Date.now());

    const CurrentIdx = BleedingProgression.indexOf(Runtime.BleedingStatus);
    const NextIdx = Math.min(CurrentIdx + 1, BleedingProgression.length - 1);
    const Next = BleedingProgression[NextIdx];
    if (Next === undefined || Next === 'NotBleeding') return;
    if (Next === Runtime.BleedingStatus) {
      this.Log.Debug(
        `Confirmed hit at terminal tier - source=${Victim} tier=${Next} ` +
          `weapon=${WeaponHash >>> 0} component=${HitComponent ?? 'none'}`,
      );
      return;
    }

    await this.ApplyTierChange(Victim, Runtime, Next);
    this.Chat.SendTo(Victim, ChatFormatter.Warning(BleedingToast[Next]));
    this.Log.Debug(
      `Escalated - source=${Victim} tier=${Next} weapon=${WeaponHash >>> 0} ` +
        `component=${HitComponent ?? 'none'} combinedDrop=${BaselineCombined - CurrentCombined} ` +
        `drainDiscount=${DrainDiscount}`,
    );
  }

  /**
   * Shared body for every tier write (escalation, relief, admin).
   * Mutates the runtime (which replicates the status bag), persists the
   * single column, and resets the session timers when the wound closes
   * so the next wound starts its drip / drain / stumble clocks fresh.
   */
  private async ApplyTierChange(
    Source: number,
    Runtime: CharacterRuntime,
    Tier: BleedingStatus,
  ): Promise<void> {
    this.Runtimes.SetBleedingStatus(Source, Tier);
    if (Tier === 'NotBleeding') this.ResetStamps(Source);
    try {
      await this.Characters.SaveBleeding(Runtime.CharacterID, Tier);
    } catch (Err: unknown) {
      this.Log.Error(`SaveBleeding failed - character=${Runtime.CharacterID}`, {
        Err: String(Err),
      });
    }
  }

  /**
   * Clear the per-wound clocks and the escalation cooldown, keeping the
   * splat ring (those drops are still in the world and still count
   * toward the per-character cap).
   */
  private ResetStamps(Source: number): void {
    this.LastEscalationAt.delete(Source);
    const Entry = this.Entries.get(Source);
    if (Entry === undefined) return;
    Entry.LastDripAt = null;
    Entry.LastDrainAt = null;
    Entry.LastStumbleAt = null;
    Entry.LastSplatCoord = null;
  }

  // ── Scheduler internals ─────────────────────────────────────────────

  /**
   * One pass of the 1 s scheduler: walks every Spawned bleeder's drip /
   * drain / stumble timers. The pass also self-heals the session
   * stamps: when an external system (the injury revive paths) clears
   * the tier to NotBleeding directly, bypassing ApplyTierChange, the
   * stale clocks are reset here so the next wound starts its intervals
   * fresh instead of firing instantly.
   */
  private TickSpawned(): void {
    const Now = Date.now();
    for (const Src of this.State.GetSpawnedSources()) {
      try {
        const Runtime = this.Runtimes.Get(Src);
        if (Runtime === null) continue;
        const Tier = Runtime.BleedingStatus;
        if (Tier === 'NotBleeding') {
          const Stale = this.Entries.get(Src);
          if (
            Stale !== undefined &&
            (Stale.LastDripAt !== null ||
              Stale.LastDrainAt !== null ||
              Stale.LastStumbleAt !== null ||
              Stale.LastSplatCoord !== null)
          ) {
            // SplatRing deliberately survives - those drops are still
            // in the world and still count toward the per-character cap.
            this.ResetStamps(Src);
          }
          continue;
        }
        const Entry = this.UpsertEntry(Src);
        // Splats drip in EVERY InjuryStatus - a downed body pools blood
        // exactly like a walking bleeder. Drain and stumble only apply
        // while Healthy: the injury layer already owns the HP clamp and
        // the pose of an incapacitated character, and a drain tick
        // against the injury floor would fight that clamp.
        // The scheduler is synchronous, so its try/catch below cannot see
        // a rejection from this branch - the drip needs its own.
        void this.TickSplat(Src, Runtime, Tier, Entry, Now).catch((Err: unknown) => {
          this.Log.Error(`Splat drip rejected for source=${Src}`, { Err: String(Err) });
        });
        if (Runtime.InjuryStatus === 'Healthy') {
          this.TickDrain(Src, Tier, Entry, Now);
          this.TickStumble(Src, Tier, Entry, Now);
        }
      } catch (Err: unknown) {
        this.Log.Error(`Scheduler tick failed for source=${Src}`, { Err: String(Err) });
      }
    }
  }

  /**
   * Lay one blood-splat evidence fixture at the bleeder's feet each
   * elapsed drip interval. The spacing gate restamps without dropping
   * when the bleeder has not moved BloodSplatMinSpacingMeters from
   * their previous splat - a stationary bleeder pools into one splat
   * instead of stacking a column. The ring buffer recycles the oldest
   * splat past the per-character cap so an endless trail cannot grow
   * the ground-drop table without bound.
   */
  private async TickSplat(
    Src: number,
    Runtime: CharacterRuntime,
    Tier: BleedingStatus,
    Entry: BleedingEntry,
    Now: number,
  ): Promise<void> {
    const Interval = BleedingDripIntervalMs[Tier];
    if (Interval === null) return;
    if (Entry.LastDripAt === null) {
      Entry.LastDripAt = Now;
      return;
    }
    if (Now - Entry.LastDripAt < Interval) return;
    Entry.LastDripAt = Now;

    const Coords = this.PedCoords(Src);
    if (Coords === null) return;
    if (Entry.LastSplatCoord !== null) {
      const Dx = Coords.X - Entry.LastSplatCoord.X;
      const Dy = Coords.Y - Entry.LastSplatCoord.Y;
      const Dz = Coords.Z - Entry.LastSplatCoord.Z;
      if (
        Dx * Dx + Dy * Dy + Dz * Dz <
        BloodSplatMinSpacingMeters * BloodSplatMinSpacingMeters
      ) {
        return;
      }
    }

    const Metadata = JSON.stringify({
      BloodType: Runtime.BloodType,
      CharacterID: Runtime.CharacterID,
    });
    const DropID = await this.Inventory.SpawnEvidenceDrop(Src, BloodSplatItemTypeID, Metadata);
    if (DropID === null) return;
    Entry.LastSplatCoord = Coords;
    Entry.SplatRing.push(DropID);
    while (Entry.SplatRing.length > BloodSplatMaxLivePerCharacter) {
      const OldID = Entry.SplatRing.shift();
      if (OldID === undefined) break;
      await this.Inventory.RemoveGroundDropBySystem(OldID);
    }
  }

  /**
   * Cost one column-range HP each elapsed drain interval, down to the
   * tier's floor. The delta rides NetEvents.BleedingDrainTick as a
   * RELATIVE adjustment the client applies atomically against its live
   * engine HP - SET_ENTITY_HEALTH has no apiset-server variant, and an
   * absolute value computed from the server's replicated read would
   * race concurrent gunfire and resurrect damage dealt in flight.
   *
   * Every sanctioned drop is registered with the anti-cheat scanner
   * (Scanner.NoteServerHpAdjustment) so an open GodModeHealth hit
   * window can fold it into its baseline once the replicated value
   * shows the drop actually landed. Without that registration the drain
   * would move combined HP below the window baseline and silently
   * refute it - a god-moder under fire would only need to be bleeding
   * to never get flagged. The fold is deferred to observation on the
   * scanner side because an emit is only an instruction: a health-lock
   * cheat that swallows it must not be able to walk the baseline away
   * from its own frozen HP.
   *
   * Every emitted drop is also stamped and, while a hit confirm is
   * pending, accumulated into ConfirmDrainDiscounts - the escalation
   * path must never read the wound's own drain as confirmation that a
   * hit dealt damage.
   */
  private TickDrain(Src: number, Tier: BleedingStatus, Entry: BleedingEntry, Now: number): void {
    const Interval = BleedingDrainIntervalMs[Tier];
    if (Interval === null) return;
    if (Entry.LastDrainAt === null) {
      Entry.LastDrainAt = Now;
      return;
    }
    if (Now - Entry.LastDrainAt < Interval) return;
    Entry.LastDrainAt = Now;

    const Floor = BleedingDrainFloorHp[Tier];
    if (Floor === null) return;
    const Ped = this.Ped(Src);
    if (Ped === 0) return;
    // Engine HP for an alive ped sits in the 100..200 band; the column
    // range the floors are expressed in is that band minus 100.
    const ColumnHp = Math.max(0, Math.min(100, GetEntityHealth(Ped) - 100));
    if (ColumnHp - BleedingDrainHpPerTick < Floor) return;

    const Payload: NetEventPayloads[typeof NetEvents.BleedingDrainTick] = {
      HpDelta: -BleedingDrainHpPerTick,
    };
    try {
      emitNet(NetEvents.BleedingDrainTick, Src, Payload);
    } catch (Err: unknown) {
      this.Log.Warn(`Drain emit failed source=${Src}`, { Err: String(Err) });
      return;
    }
    this.Scanner.NoteServerHpAdjustment(Src, -BleedingDrainHpPerTick);
    Entry.LastDrainEmitAt = Now;
    if (this.PendingConfirms.has(Src)) {
      this.ConfirmDrainDiscounts.set(
        Src,
        (this.ConfirmDrainDiscounts.get(Src) ?? 0) + BleedingDrainHpPerTick,
      );
    }
  }

  /**
   * Periodic stumble while HeavyBleeding on foot: a short server-driven
   * ragdoll (SET_PED_TO_RAGDOLL is apiset-server, verified) as a
   * visible, involuntary tell that the wound is untreated. The interval
   * restamps on every eligible evaluation - time spent in a vehicle
   * consumes the interval without ragdolling, so stepping out does not
   * trigger an instant stored-up stumble.
   *
   * HARD RULE: never call SetPedCanRagdoll(false) anywhere in this
   * path. The client anti-cheat monitor flags CanPedRagdoll === false
   * as RagdollHack; suppressing ragdoll server-side would mark every
   * heavy bleeder a cheater.
   */
  private TickStumble(Src: number, Tier: BleedingStatus, Entry: BleedingEntry, Now: number): void {
    if (Tier !== 'HeavyBleeding') return;
    if (Entry.LastStumbleAt === null) {
      Entry.LastStumbleAt = Now;
      return;
    }
    if (Now - Entry.LastStumbleAt < BleedingStumbleIntervalMs) return;
    Entry.LastStumbleAt = Now;

    const Ped = this.Ped(Src);
    if (Ped === 0) return;
    if (GetVehiclePedIsIn(Ped, false) !== 0) return;
    try {
      SetPedToRagdoll(
        Ped,
        BleedingStumbleDurationMs,
        BleedingStumbleDurationMs,
        0,
        false,
        false,
        false,
      );
    } catch (Err: unknown) {
      this.Log.Warn(`Stumble ragdoll failed source=${Src}`, { Err: String(Err) });
    }
  }

  /**
   * TTL sweep over the blood_splat ground drops. Catches everything the
   * per-character ring cannot: splats orphaned by disconnects, splats
   * from characters who stopped bleeding, and rings that never hit the
   * live cap.
   */
  private async SweepSplats(): Promise<void> {
    try {
      const Removed = await this.Inventory.SweepEvidenceDrops(
        BloodSplatItemTypeID,
        BloodSplatMaxAgeMs,
      );
      if (Removed > 0) this.Log.Debug(`Splat TTL sweep removed ${Removed} drop(s)`);
    } catch (Err: unknown) {
      this.Log.Error('Splat TTL sweep failed', { Err: String(Err) });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Fetch or create a player's bleeding bookkeeping. Timers start null
   * and initialise lazily on the first sweep that sees them bleeding, so
   * the first drip lands a full interval after the wound opens rather
   * than instantly.
   */
  private UpsertEntry(Src: number): BleedingEntry {
    let Entry = this.Entries.get(Src);
    if (Entry === undefined) {
      Entry = {
        LastDripAt: null,
        LastDrainAt: null,
        LastDrainEmitAt: null,
        LastStumbleAt: null,
        LastSplatCoord: null,
        SplatRing: [],
      };
      this.Entries.set(Src, Entry);
    }
    return Entry;
  }

  /** Whether a Source currently has a character in the world. */
  private IsSpawned(Src: number): boolean {
    return this.State.Get(Src)?.Phase === 'Spawned';
  }

  /** A player's ped handle, or 0 when unresolvable. */
  private Ped(Src: number): number {
    try {
      return GetPlayerPed(String(Src));
    } catch {
      return 0;
    }
  }

  /**
   * A player's position, or null if unresolvable - where the next blood
   * splat is placed, and what the spacing gate compares against.
   */
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
}
