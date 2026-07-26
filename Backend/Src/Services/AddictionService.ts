import {
  AddictionLevelCap,
  AddictionThreshold,
  AddictionTuning,
  DecayedAddictionLevel,
  DoseScaleMax,
  DoseScaleMin,
  WithdrawalDrainFloorHp,
  WithdrawalDrainHp,
  WithdrawalSweepIntervalMs,
  WithdrawalSymptomIntervalMs,
  type DrugClass,
} from '@Shared/Constants/Drugs.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { CharacterAddictionRepository } from '@/Data/Repositories/CharacterAddictionRepository.js';
import type { AsyncLock } from '@/Services/AsyncLock.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { NametagActionService } from '@/Services/NametagActionService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityHealth(Entity: number): number;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Per-class addiction ledger + the withdrawal loop. No cosmetic
 * effects by design (decided 2026-06-12): the sickness lands through
 * involuntary `/me` narration and a slow HP drain - the same two
 * channels every other system on this text-RP server uses.
 *
 *   - `RecordDose` is the only writer: decay the stored level to
 *     now, add the class gain, stamp. Drugs hand off from the
 *     command layer per use; alcohol hands off per drink scaled by
 *     ethanol grams. Serialised per character through the shared
 *     AsyncLock, same shape as the blood-alcohol ingest.
 *   - `Start` arms the sweep: once a minute, every spawned, Healthy
 *     player whose symptom spacing has elapsed gets their ledger
 *     read; a class past the threshold whose dose window has lapsed
 *     produces one symptom - a rotated class narration floated above
 *     the head (the /ame channel) plus a one-point HP drain floored
 *     well above the injury machine's territory. Dosing again resets
 *     the window (and
 *     deepens the ledger); days of abstinence decay back below the
 *     threshold.
 *
 * Withdrawal drains ride NetEvents.AddictionWithdrawalTick as
 * relative deltas and register with the anti-cheat scanner through
 * the late-attached sink, for exactly the bleeding drain's reason: a
 * sanctioned drop must not silently refute an open GodModeHealth
 * window.
 */
export class AddictionService {
  private readonly Log = Logger.New('Addiction');
  /** Source -> wall-clock ms of the last symptom (spacing gate). */
  private readonly LastSymptomAt = new Map<number, number>();
  /** Source -> rotating index into the class narration list. */
  private readonly NarrationCursor = new Map<number, number>();
  /**
   * Characters known to have an empty ledger - skipped by the sweep
   * until their first dose lands (RecordDose invalidates). Keyed by
   * CharacterID, not Source, so a character switch on the same slot
   * never inherits another character's cleanliness. Grows by one
   * entry per distinct clean character since boot, like the
   * inventory hot-path cache - negligible.
   */
  private readonly CleanCharacters = new Set<string>();
  /** Re-entrancy latch - a DB stall must not pile sweeps on itself. */
  private SweepInFlight = false;
  private SweepInterval: ReturnType<typeof setInterval> | null = null;
  private HpAdjustmentSink: ((Source: number, HpDelta: number) => void) | null = null;

  constructor(
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly NametagActions: NametagActionService,
    private readonly Repo: CharacterAddictionRepository,
    private readonly Lock: AsyncLock,
  ) {}

  /** Late-attached scanner hook (Bootstrap order: scanner trails this service). */
  SetHpAdjustmentSink(Sink: (Source: number, HpDelta: number) => void): void {
    this.HpAdjustmentSink = Sink;
  }

  /**
   * Drop the per-Source sweep bookkeeping. The Sweep evicts lazily once
   * PlayerState goes null, which covers a disconnect - but NOT a
   * character switch, where the Source (and its PlayerState) survives
   * and only the character behind it changes. Without this the next
   * character on the connection inherits the previous one's symptom
   * spacing and could have their first withdrawal tell suppressed for
   * a full interval. Called from the same teardown that resets NoClip,
   * anti-cheat and injury session state.
   */
  Evict(Source: number): void {
    this.LastSymptomAt.delete(Source);
    this.NarrationCursor.delete(Source);
  }

  /**
   * Begin the withdrawal sweep, which decays tolerance and applies
   * withdrawal effects over time. Idempotent; the sweep's own rejections
   * are caught so one failure cannot kill the interval.
   */
  Start(): void {
    if (this.SweepInterval !== null) return;
    this.SweepInterval = setInterval((): void => {
      void this.Sweep().catch((Err: unknown) => {
        this.Log.Error('Withdrawal sweep rejected', { Err: String(Err) });
      });
    }, WithdrawalSweepIntervalMs);
    this.Log.Info(`Withdrawal sweep armed (every ${WithdrawalSweepIntervalMs}ms)`);
  }

  /**
   * Fold one dose into the character's ledger for `Class`.
   * Fire-and-forget from the command layer - a failed write loses
   * one dose's addiction gain, never the item. DoseScale is 1 for a
   * unit of narcotics; alcohol passes grams / standard-drink so a
   * shot and a bottle weigh differently, clamped so one giant pour
   * cannot hook a character instantly.
   */
  async RecordDose(Source: number, Class: DrugClass, DoseScale = 1): Promise<void> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.CharacterID === null) return;
    if (!Number.isFinite(DoseScale) || DoseScale <= 0) return;
    const CharacterID = PlayerState.CharacterID;
    try {
      const Release = await this.Lock.Acquire(`Addiction:${CharacterID}`);
      try {
        const Row = await this.Repo.FindOne(CharacterID, Class);
        const Now = new Date();
        const StoredRaw = Row !== null ? Number.parseFloat(Row.Level) : 0;
        const Stored = Number.isFinite(StoredRaw) ? StoredRaw : 0;
        const Current =
          Row === null || Row.LastDoseAt === null
            ? Stored
            : DecayedAddictionLevel(Stored, Now.getTime() - Row.LastDoseAt.getTime(), Class);
        const Scale = Math.min(DoseScaleMax, Math.max(DoseScaleMin, DoseScale));
        const Next = Math.min(
          AddictionLevelCap,
          Current + AddictionTuning[Class].GainPerDose * Scale,
        );
        await this.Repo.SaveDose(CharacterID, Class, Next, Now);
        this.CleanCharacters.delete(CharacterID);
      } finally {
        Release();
      }
    } catch (Err: unknown) {
      this.Log.Warn(`RecordDose failed source=${Source} class=${Class}`, { Err: String(Err) });
    }
  }

  /**
   * One withdrawal pass over the spawned roster: collect the eligible
   * players (symptom spacing elapsed, Healthy, not known-clean), read
   * ALL their ledgers in ONE batched query, then evaluate in memory.
   * Players whose ledger comes back empty enter the clean cache and
   * cost nothing until their first dose. Incapacitated players are
   * skipped outright - a downed body has larger problems, and the
   * drain must never fight the injury machine's clamp. The in-flight
   * latch keeps a stalled query from piling sweeps on themselves and
   * double-firing symptoms.
   */
  private async Sweep(): Promise<void> {
    if (this.SweepInFlight) return;
    this.SweepInFlight = true;
    try {
      const Now = Date.now();
      const Eligible: { Source: number; CharacterID: string }[] = [];
      for (const Source of this.State.GetSpawnedSources()) {
        const Last = this.LastSymptomAt.get(Source);
        if (Last !== undefined && Now - Last < WithdrawalSymptomIntervalMs) continue;
        const Runtime = this.Runtimes.Get(Source);
        if (Runtime === null || Runtime.InjuryStatus !== 'Healthy') continue;
        if (this.CleanCharacters.has(Runtime.CharacterID)) continue;
        Eligible.push({ Source, CharacterID: Runtime.CharacterID });
      }
      if (Eligible.length > 0) {
        const Rows = await this.Repo.FindByCharacters(Eligible.map((E) => E.CharacterID));
        const ByCharacter = new Map<string, typeof Rows>();
        for (const Row of Rows) {
          const Bucket = ByCharacter.get(Row.CharacterID);
          if (Bucket === undefined) ByCharacter.set(Row.CharacterID, [Row]);
          else Bucket.push(Row);
        }
        for (const Entry of Eligible) {
          const CharacterRows = ByCharacter.get(Entry.CharacterID);
          if (CharacterRows === undefined) {
            this.CleanCharacters.add(Entry.CharacterID);
            continue;
          }
          let WorstClass: DrugClass | null = null;
          let WorstLevel = 0;
          for (const Row of CharacterRows) {
            const Tuning = AddictionTuning[Row.DrugClass];
            if (Tuning === undefined || Row.LastDoseAt === null) continue;
            const Elapsed = Now - Row.LastDoseAt.getTime();
            if (Elapsed < Tuning.WithdrawalOnsetHours * 3_600_000) continue;
            const StoredRaw = Number.parseFloat(Row.Level);
            const Stored = Number.isFinite(StoredRaw) ? StoredRaw : 0;
            const Decayed = DecayedAddictionLevel(Stored, Elapsed, Row.DrugClass);
            if (Decayed < AddictionThreshold) continue;
            if (Decayed > WorstLevel) {
              WorstLevel = Decayed;
              WorstClass = Row.DrugClass;
            }
          }
          if (WorstClass === null) continue;
          this.EmitSymptom(Entry.Source, WorstClass);
          this.LastSymptomAt.set(Entry.Source, Now);
        }
      }
      // Lazy eviction: per-source bookkeeping for anyone gone.
      for (const Source of this.LastSymptomAt.keys()) {
        if (this.State.Get(Source) === null) {
          this.LastSymptomAt.delete(Source);
          this.NarrationCursor.delete(Source);
        }
      }
    } catch (Err: unknown) {
      this.Log.Warn('Sweep failed', { Err: String(Err) });
    } finally {
      this.SweepInFlight = false;
    }
  }

  /**
   * One symptom: a rotated involuntary narration floated above the
   * head (the /ame channel, not chat - involuntary tells share the
   * float with deliberate item interactions), plus a one-point drain
   * unless the ped already sits at the withdrawal floor. The drain
   * mirrors the bleeding tick - relative delta, server-gated floor,
   * scanner registration - but at a pace that harasses rather than
   * kills.
   */
  private EmitSymptom(Source: number, Class: DrugClass): void {
    const Narrations = AddictionTuning[Class].Narrations;
    const Cursor = this.NarrationCursor.get(Source) ?? 0;
    const Body = Narrations[Cursor % Narrations.length] ?? Narrations[0] ?? 'shudders.';
    this.NarrationCursor.set(Source, Cursor + 1);
    this.NametagActions.SetAction(Source, Body);
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      const RawHealth = GetEntityHealth(Ped);
      const ColumnHp = Number.isFinite(RawHealth)
        ? Math.max(0, Math.min(100, RawHealth - 100))
        : 0;
      if (ColumnHp - WithdrawalDrainHp < WithdrawalDrainFloorHp) return;
      const Payload: NetEventPayloads[typeof NetEvents.AddictionWithdrawalTick] = {
        HpDelta: -WithdrawalDrainHp,
      };
      emitNet(NetEvents.AddictionWithdrawalTick, Source, Payload);
      this.HpAdjustmentSink?.(Source, -WithdrawalDrainHp);
    } catch (Err: unknown) {
      this.Log.Warn(`EmitSymptom drain failed source=${Source}`, { Err: String(Err) });
    }
  }
}
