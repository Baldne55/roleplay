import { AllowedPedModelHashes, WeaponUnarmedHash } from '@Shared/Constants/Anticheat.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';
import type { InventoryService } from '@/Services/InventoryService.js';

declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetSelectedPedWeapon(Ped: number): number;
declare function GetPlayerInvincible(PlayerSrc: string): boolean;
declare function GetEntityModel(Entity: number): number;
declare function GetEntityHealth(Entity: number): number;
declare function GetPedArmour(Ped: number): number;

/** Strike-based detections this scanner samples once per sweep. */
type StrikeDetectionType = 'HeldWeaponMismatch' | 'GodModeFlag' | 'PedModelChange';

/** Everything the scanner can report (the hit-window check joins the strike set). */
type ScannerDetectionType = StrikeDetectionType | 'GodModeHealth';

/**
 * Open hit-accumulation window for the GodModeHealth check. Opened by
 * the first NoteHit for a Source; evaluated and expired by the sweep.
 */
interface HitWindow {
  OpenedAtMs: number;
  /** GetEntityHealth + GetPedArmour at the moment the window opened. */
  BaselineCombined: number;
  Hits: number;
  /**
   * Sanctioned server-instructed combined-HP change (negative for
   * drops, e.g. a bleeding drain tick) emitted while this window was
   * open but not yet observed in the replicated read. The sweep folds
   * it into BaselineCombined only as the replicated value is seen to
   * move (ReconcileSanctionedDelta) - an emit is an instruction, not a
   * fact, and trusting it alone would let a health-lock cheat walk the
   * baseline away from its own frozen HP.
   */
  PendingSanctionedDelta: number;
}

/**
 * Per-Source scanner bookkeeping for one spawn. Everything here is
 * spawn-scoped, not connection-scoped: de-spawning resets the grace
 * anchors so a respawn does not inherit strikes or suppression windows
 * accrued under a previous character.
 */
interface ScannerEntry {
  /** Consecutive bad samples per detection; one clean sample resets to 0. */
  Strikes: Map<StrikeDetectionType, number>;
  /** Post-report quiet period per detection; samples skip until it passes. */
  SuppressedUntilMs: Map<ScannerDetectionType, number>;
  HitWindow: HitWindow | null;
  /**
   * When the sweep first observed this Source in the Spawned phase. Anchors
   * the post-spawn grace for the invincibility-flag and model checks. Null
   * until the first Spawned sample; reset to null on de-spawn so a later
   * respawn (e.g. /changecharacter) restarts the grace from scratch.
   */
  FirstSpawnSeenAtMs: number | null;
}

/**
 * Per-player anti-cheat sweep over replicated engine state. Every 5s it
 * walks the Spawned sources and samples four cheat-shaped signals, all
 * readable server-side via apiset-server natives over OneSync data:
 *
 *   - HeldWeaponMismatch: the weapon the ped is actually holding
 *     (GetSelectedPedWeapon) versus the server-written equipped-weapon
 *     bag. Unarmed always passes - holstering is not a crime.
 *   - GodModeFlag: the replicated player-invincibility flag, unless the
 *     server itself sanctioned it (noclip legitimately sets
 *     invincibility client-side). Does not catch the keep-ragdoll
 *     invincibility variant - that is the client monitor's job.
 *   - PedModelChange: ped model outside the two server-assigned
 *     freemode hashes.
 *   - GodModeHealth: hit-window heuristic fed by NoteHit() from the
 *     weaponDamageEvent path - repeated confirmed hits with zero
 *     combined HP + armour movement across the window.
 *
 * Strike discipline: one bad sample is a strike, two CONSECUTIVE
 * strikes report. The equip / strip round-trip to the owning client can
 * lag one sweep, so a single-sweep mismatch is expected noise. After a
 * report the detection is suppressed for that Source for 60s so a
 * sustained cheat scores once a minute instead of once a sweep - the
 * AnticheatPolicies weights are tuned for that cadence.
 *
 * Known noise (acceptable under the observe-only default): incapacitated
 * players sit at the injury HP floor and receive scripted health clamps,
 * so hits landed on a downed body can evaluate as "no HP movement" and
 * report GodModeHealth. Staff review filters those.
 */
export class AnticheatScannerService {
  private readonly Log = Logger.New('AnticheatScanner');
  private readonly Entries = new Map<number, ScannerEntry>();
  private readonly SweepIntervalMs = 5000;
  private readonly StrikesToReport = 2;
  private readonly SuppressionMs = 60_000;
  private readonly HitWindowLifetimeMs = 15_000;
  private readonly HitWindowMinAgeMs = 5000;
  private readonly HitWindowMinHits = 4;
  /**
   * Post-spawn settle window. During the auth-shell / spawn transition the
   * engine briefly replicates spawn-protection invincibility and a
   * not-yet-swapped placeholder model; the flag and model checks skip until
   * a Source has been continuously Spawned for at least this long. Same
   * post-spawn-settle intent as the position validator's spawn grace, sized
   * a touch longer to cover the slower auth-shell handoff.
   */
  private readonly SpawnGraceMs = 10_000;
  /**
   * Slack on the combined HP + armour equality test for the GodModeHealth
   * report. Combined values are engine integers, so a real god-mode window
   * shows an exact match; this tolerance only absorbs incidental rounding.
   * Any increase beyond it is read as a heal, not invincibility.
   */
  private readonly HealReportToleranceCombined = 1;
  private SweepHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly State: PlayerStateService,
    private readonly Anticheat: AnticheatService,
    private readonly Inventory: InventoryService,
  ) {}

  /** Begin the periodic sweep. Idempotent - a second call is a no-op. */
  Start(): void {
    if (this.SweepHandle !== null) return;
    this.SweepHandle = setInterval(() => this.Sweep(), this.SweepIntervalMs);
    this.Log.Debug(
      `Started - sweep=${this.SweepIntervalMs}ms strikes=${this.StrikesToReport} suppression=${this.SuppressionMs}ms`,
    );
  }

  /** Halt the sweep, for shutdown or a resource restart. Idempotent. */
  Stop(): void {
    if (this.SweepHandle === null) return;
    clearInterval(this.SweepHandle);
    this.SweepHandle = null;
  }

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Drops the sweep entry: strike counters,
   * suppression stamps, and any open hit window.
   */
  Evict(Source: number): void {
    this.Entries.delete(Source);
  }

  /**
   * Confirmed weapon hit on a victim (weaponDamageEvent, hit entity
   * resolved to that player's own ped). The first hit opens a 15s
   * window with the victim's current HP + armour as baseline; further
   * hits increment the counter. The sweep decides whether the window
   * ever showed damage movement.
   */
  NoteHit(VictimSource: number): void {
    const Entry = this.UpsertEntry(VictimSource);
    const Now = Date.now();
    if (this.IsSuppressed(Entry, 'GodModeHealth', Now)) return;
    if (Entry.HitWindow !== null) {
      Entry.HitWindow.Hits += 1;
      return;
    }
    const Ped = GetPlayerPed(String(VictimSource));
    if (Ped === 0) return;
    Entry.HitWindow = {
      OpenedAtMs: Now,
      BaselineCombined: GetEntityHealth(Ped) + GetPedArmour(Ped),
      Hits: 1,
      PendingSanctionedDelta: 0,
    };
  }

  /**
   * One pass over spawned players, running the polling detections that
   * have no event to hook - god mode, held weapons that were never
   * granted, and the like.
   *
   * Complements the event-driven AnticheatEventController: that one
   * reacts to packets, this one notices states no packet announces.
   */
  private Sweep(): void {
    const Now = Date.now();
    const SpawnedSources = this.State.GetSpawnedSources();
    this.ResetGraceForDespawned(SpawnedSources);
    for (const Source of SpawnedSources) {
      try {
        const Ped = GetPlayerPed(String(Source));
        if (Ped === 0) continue;
        const Entry = this.UpsertEntry(Source);
        // Anchor the spawn grace the first sweep this Source is seen Spawned.
        if (Entry.FirstSpawnSeenAtMs === null) Entry.FirstSpawnSeenAtMs = Now;
        const WithinSpawnGrace = Now - Entry.FirstSpawnSeenAtMs < this.SpawnGraceMs;
        this.CheckHeldWeapon(Source, Ped, Entry, Now);
        // GodModeFlag and PedModelChange can sample spawn-protection
        // invincibility or a placeholder model during the spawn transition;
        // suppress them until the grace elapses. HeldWeaponMismatch and
        // GodModeHealth are unaffected by spawn invincibility.
        if (!WithinSpawnGrace) {
          this.CheckGodModeFlag(Source, Entry, Now);
          this.CheckPedModel(Source, Ped, Entry, Now);
        }
        this.EvaluateHitWindow(Source, Ped, Entry, Now);
      } catch (Err: unknown) {
        this.Log.Error(`Sweep failed for source=${Source}`, { Err: String(Err) });
      }
    }
  }

  /**
   * Clear the spawn-grace anchor for any tracked Source that is no longer
   * Spawned (character switch, death-to-shell). The next time the Source
   * re-enters Spawned the sweep re-anchors from scratch, so a respawn such
   * as /changecharacter restarts the grace rather than inheriting the stale
   * timestamp. Sources lost outright are evicted on playerDropped.
   */
  private ResetGraceForDespawned(SpawnedSources: readonly number[]): void {
    const SpawnedSet = new Set(SpawnedSources);
    for (const [Source, Entry] of this.Entries) {
      if (Entry.FirstSpawnSeenAtMs !== null && !SpawnedSet.has(Source)) {
        Entry.FirstSpawnSeenAtMs = null;
      }
    }
  }

  /**
   * Compare the weapon the ped actually holds against the equipped bag.
   * GetSelectedPedWeapon aliases GET_CURRENT_PED_WEAPON server-side and
   * returns a sign-ambiguous joaat - both sides normalize through
   * `>>> 0` before compare. A null bag with a weapon in hand is the
   * same strike as a wrong hash.
   */
  private CheckHeldWeapon(Source: number, Ped: number, Entry: ScannerEntry, Now: number): void {
    if (this.IsSuppressed(Entry, 'HeldWeaponMismatch', Now)) return;
    const HeldHash = GetSelectedPedWeapon(Ped) >>> 0;
    if (HeldHash === WeaponUnarmedHash) {
      Entry.Strikes.set('HeldWeaponMismatch', 0);
      return;
    }
    const RawBagHash = this.Inventory.ReadEquippedBag(Source)?.WeaponHash ?? null;
    const BagHash = RawBagHash === null ? null : RawBagHash >>> 0;
    if (BagHash === HeldHash) {
      Entry.Strikes.set('HeldWeaponMismatch', 0);
      return;
    }
    this.StrikeAndMaybeReport(Source, Entry, 'HeldWeaponMismatch', Now, { HeldHash, BagHash });
  }

  /**
   * Replicated invincibility flag the client's own engine serialises.
   * Server-sanctioned noclip legitimately sets it, so the sanction
   * ledger gates the strike - always the server-memory map, never a
   * state bag.
   */
  private CheckGodModeFlag(Source: number, Entry: ScannerEntry, Now: number): void {
    if (this.IsSuppressed(Entry, 'GodModeFlag', Now)) return;
    const Invincible =
      GetPlayerInvincible(String(Source)) === true && !this.Anticheat.IsSanctioned(Source, 'NoClip');
    if (!Invincible) {
      Entry.Strikes.set('GodModeFlag', 0);
      return;
    }
    this.StrikeAndMaybeReport(Source, Entry, 'GodModeFlag', Now, {});
  }

  /**
   * Every server-assigned character model is one of the two freemode
   * peds; anything else on a player ped is a model swap. A 0 read means
   * the entity is mid-stream - skip the sample entirely (no strike, no
   * reset) rather than judge unvouched data.
   */
  private CheckPedModel(Source: number, Ped: number, Entry: ScannerEntry, Now: number): void {
    if (this.IsSuppressed(Entry, 'PedModelChange', Now)) return;
    const ModelHash = GetEntityModel(Ped) >>> 0;
    if (ModelHash === 0) return;
    if (AllowedPedModelHashes.includes(ModelHash)) {
      Entry.Strikes.set('PedModelChange', 0);
      return;
    }
    this.StrikeAndMaybeReport(Source, Entry, 'PedModelChange', Now, { ModelHash });
  }

  /**
   * Decide an open GodModeHealth window. Reports only when the window
   * accumulated enough hits, aged past the replication settle time, and
   * combined HP + armour is still essentially EQUAL to the open baseline -
   * god mode means the value literally never moved.
   *
   * Both directions of movement close the window silently:
   *   - A decrease below baseline refutes the hypothesis: damage visibly
   *     landed.
   *   - An increase above baseline is a heal inside the window
   *     (hospital respawn, /helpup, /arevive), not invincibility. Without
   *     this guard the heal would also satisfy "not below baseline" and
   *     falsely flag the healed victim.
   *
   * Sanctioned noclip skips evaluation (its invincibility legitimately
   * swallows damage); the window then closes via the 15s expiry.
   *
   * Sanctioned server-instructed HP changes (the bleeding drain) fold
   * into the baseline only as the replicated value is observed to have
   * moved by them (ReconcileSanctionedDelta), so they neither refute
   * the window nor - when a health-lock cheat swallows the instruction
   * - walk the baseline into the heal guard. Whatever remains
   * unapplied at report time rides along as evidence: a client that
   * ignored a server-instructed drop is near-certainly locking its
   * health.
   */
  private EvaluateHitWindow(Source: number, Ped: number, Entry: ScannerEntry, Now: number): void {
    const Window = Entry.HitWindow;
    if (Window === null) return;
    if (Now - Window.OpenedAtMs > this.HitWindowLifetimeMs) {
      Entry.HitWindow = null;
      return;
    }
    if (this.Anticheat.IsSanctioned(Source, 'NoClip')) return;
    if (Window.Hits < this.HitWindowMinHits || Now - Window.OpenedAtMs < this.HitWindowMinAgeMs) {
      return;
    }
    const CurrentCombined = GetEntityHealth(Ped) + GetPedArmour(Ped);
    const Applied = this.ReconcileSanctionedDelta(Window, CurrentCombined);
    if (Applied > 0) {
      // Part of a sanctioned RISE (consumable regen) was observed to
      // land: the client demonstrably applied a server HP instruction,
      // which refutes a health lock outright. The equality test cannot
      // run on what remains - genuine damage may be hiding inside the
      // attributed rise (regen and damage move in opposite directions,
      // unlike the bleeding drain) - so close silently rather than risk
      // flagging an honest medkit-under-fire. A frozen-HP client shows
      // Observed = 0, attributes nothing, and still reports below with
      // the full pending delta as evidence.
      Entry.HitWindow = null;
      return;
    }
    if (CurrentCombined > Window.BaselineCombined + this.HealReportToleranceCombined) {
      // Combined health rose above baseline: a heal landed mid-window. Close
      // silently - this is the legitimate-recovery false positive being fixed.
      Entry.HitWindow = null;
      return;
    }
    if (CurrentCombined < Window.BaselineCombined - this.HealReportToleranceCombined) {
      // Combined health dropped below baseline: damage landed, refuting god mode.
      Entry.HitWindow = null;
      return;
    }
    this.Anticheat.Report(Source, 'GodModeHealth', {
      Hits: Window.Hits,
      BaselineCombined: Window.BaselineCombined,
      CurrentCombined,
      UnappliedSanctionedDelta: Window.PendingSanctionedDelta,
    });
    Entry.SuppressedUntilMs.set('GodModeHealth', Now + this.SuppressionMs);
    Entry.HitWindow = null;
  }

  /**
   * Drop any open hit window for a Source. Wired into InjuryService's
   * heal sink (Bootstrap), so the heal flows (hospital respawn, /helpup,
   * /arevive) pre-emptively clear the window the instant the HP restore
   * is instructed. The restore rides a client round-trip, so the in-sweep
   * heal guard in EvaluateHitWindow only catches it once the replicated
   * value is seen to rise - this closes the report race in that gap.
   * No-op when no window is open or the Source has no entry.
   */
  ClearHitWindow(Source: number): void {
    const Entry = this.Entries.get(Source);
    if (Entry === undefined) return;
    Entry.HitWindow = null;
  }

  /**
   * Record a sanctioned, server-instructed HP change (negative for
   * drops - e.g. a bleeding drain tick) against an open GodModeHealth
   * window so it neither refutes nor confirms the window. The window's
   * hypothesis is "combined HP + armour never moved despite repeated
   * hits"; a server-driven drop would otherwise register as movement
   * and silently refute the window, so a god-moder would only need to
   * be bleeding while under fire to never get flagged.
   *
   * The baseline is deliberately NOT shifted here. The drop travels as
   * a client instruction, and shifting on emit would trust the client
   * to apply it: a health-lock cheat that swallows the instruction
   * would watch the baseline walk below its frozen HP until the heal
   * guard closed the window - bleeding would become a god-mode cloak.
   * The delta instead accumulates as pending, and the sweep folds it
   * into the baseline only as the replicated combined value is observed
   * to move (ReconcileSanctionedDelta). No-op when the Source has no
   * entry or no open window.
   */
  NoteServerHpAdjustment(Source: number, CombinedDelta: number): void {
    const Entry = this.Entries.get(Source);
    if (Entry === undefined || Entry.HitWindow === null) return;
    Entry.HitWindow.PendingSanctionedDelta += CombinedDelta;
  }

  /**
   * Record a server-AUTHORITATIVE combined-stat movement (armour
   * grants and drains via the apiset-server SET_PED_ARMOUR) against
   * an open GodModeHealth window. Unlike NoteServerHpAdjustment,
   * this shifts the baseline immediately: an armour write lands in
   * the server's own read regardless of anything the client does, so
   * there is no instruction to swallow and nothing to reconcile.
   * Routing these through the pending accumulator instead would be
   * actively harmful in both directions - a grant would close the
   * window as a phantom heal (a god-moder could pop a stimulant to
   * kill every maturing window), and a comedown drop would let
   * genuine swallowed-instruction evidence cancel against it.
   */
  NoteServerCombinedFact(Source: number, CombinedDelta: number): void {
    const Entry = this.Entries.get(Source);
    if (Entry === undefined || Entry.HitWindow === null) return;
    Entry.HitWindow.BaselineCombined += CombinedDelta;
  }

  /**
   * Fold the pending sanctioned delta into the window baseline, but
   * only the portion the replicated read corroborates: of the observed
   * movement away from the baseline, at most the pending amount (in the
   * pending direction) is attributed to sanctioned changes. A drop the
   * client honestly applied therefore cancels out of the evidence,
   * while a drop a health-lock cheat swallowed stays pending - the
   * baseline holds, the frozen HP keeps matching it, and the window
   * remains free to report.
   */
  /** @returns the portion folded into the baseline this sweep (signed). */
  private ReconcileSanctionedDelta(Window: HitWindow, CurrentCombined: number): number {
    if (Window.PendingSanctionedDelta === 0) return 0;
    const Observed = CurrentCombined - Window.BaselineCombined;
    const Applied =
      Window.PendingSanctionedDelta < 0
        ? Math.max(Window.PendingSanctionedDelta, Math.min(0, Observed))
        : Math.min(Window.PendingSanctionedDelta, Math.max(0, Observed));
    if (Applied === 0) return 0;
    Window.BaselineCombined += Applied;
    Window.PendingSanctionedDelta -= Applied;
    return Applied;
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Count a strike, reporting only once `StrikesToReport` accumulate.
   *
   * The scanner samples state rather than observing events, so a single
   * odd reading is unreliable - a player mid-teleport or mid-respawn can
   * look wrong for one sweep. Requiring consecutive strikes is what keeps
   * that from becoming a false positive. On reporting, the counter resets
   * and the type is suppressed for a window so one condition does not
   * score every sweep.
   */
  private StrikeAndMaybeReport(
    Source: number,
    Entry: ScannerEntry,
    Type: StrikeDetectionType,
    Now: number,
    Evidence: Record<string, unknown>,
  ): void {
    const Strikes = (Entry.Strikes.get(Type) ?? 0) + 1;
    if (Strikes < this.StrikesToReport) {
      Entry.Strikes.set(Type, Strikes);
      return;
    }
    this.Anticheat.Report(Source, Type, Evidence);
    Entry.SuppressedUntilMs.set(Type, Now + this.SuppressionMs);
    Entry.Strikes.set(Type, 0);
  }

  /** Whether this detection type is still inside its post-report cooldown. */
  private IsSuppressed(Entry: ScannerEntry, Type: ScannerDetectionType, Now: number): boolean {
    return Now < (Entry.SuppressedUntilMs.get(Type) ?? 0);
  }

  /** Fetch or create a player's scanner state (strikes, suppression, windows). */
  private UpsertEntry(Source: number): ScannerEntry {
    let Entry = this.Entries.get(Source);
    if (Entry === undefined) {
      Entry = {
        Strikes: new Map(),
        SuppressedUntilMs: new Map(),
        HitWindow: null,
        FirstSpawnSeenAtMs: null,
      };
      this.Entries.set(Source, Entry);
    }
    return Entry;
  }
}
