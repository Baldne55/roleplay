import {
  MonitorReportMinIntervalMs,
  MonitorSilentThresholdMs,
  type AnticheatDetectionType,
} from '@Shared/Constants/Anticheat.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * The validated shape of a monitor report. Note this is the type the
 * wire payload is normalised INTO - what actually arrives is `unknown`
 * and stays that way until NormaliseMonitorReport has checked every
 * field. Never annotate an inbound payload with this directly.
 */
type MonitorReport = NetEventPayloads[typeof NetEvents.AnticheatMonitorReport];

/** Detection types a single monitor report (or its absence) can raise. */
type MonitorDetectionType = Extract<
  AnticheatDetectionType,
  | 'NightVision'
  | 'ThermalVision'
  | 'FreeCam'
  | 'AimAssistOn'
  | 'InfiniteStamina'
  | 'OverMaxClip'
  | 'RagdollHack'
  | 'PedAlphaTampering'
  | 'ClientInvincibility'
  | 'MonitorSilent'
>;

/** Boolean payload fields - every one typeof-validated before any use. */
const BooleanFields = [
  'NightVision',
  'ThermalVision',
  'ClientInvincibility',
  'AimAssistOn',
  'InfiniteStamina',
  'OverMaxClip',
  'RagdollHack',
  'PedAlphaTampering',
] as const;

/** Nullable-number payload fields - null or a finite number, nothing else. */
const NullableNumberFields = ['FreeCamDistance', 'ClipAmmo', 'ClipMax', 'PedAlpha'] as const;

/** Per-Source monitor bookkeeping; evicted on playerDropped / de-spawn. */
interface MonitorEntry {
  /** Wall-clock of the last ACCEPTED report; 0 = none yet this spawn. */
  LastReportMs: number;
  /** When this controller first saw the Source spawned - the heartbeat grace anchor. */
  SpawnedSinceMs: number;
  /** Wall-clock of the last MonitorSilent report; 0 = none yet. */
  LastSilentReportMs: number;
  /** Per-detection score throttle - the client reports every 10 s and
   *  a persistent state must score once per window, not per report. */
  ThrottledUntilMs: Map<MonitorDetectionType, number>;
  /** Wall-clock of the last emitted rejection warn; 0 = none yet. */
  LastRejectWarnMs: number;
  /** Rejection warns suppressed since the last emitted one. */
  SuppressedRejectWarns: number;
}

/**
 * Backend ingest for the client anti-cheat monitor - the tier-3 wire.
 * Two registrations:
 *
 *   1. The `Roleplay:Net:Anticheat:MonitorReport` handler. Hostile
 *      payload doctrine: `source` is the identity (forge-proof),
 *      Phase=Spawned gates the wire, reports arriving sooner than
 *      MonitorReportMinIntervalMs after the previous accepted one are
 *      dropped, and every field is typeof-validated - one mismatch
 *      discards the whole report. Each flagged field then maps onto
 *      its AnticheatService detection type behind a per-Source,
 *      per-type 60 s throttle: the client emits every 10 s, so an
 *      unthrottled persistent state would score six times per minute
 *      against policies tuned for one.
 *
 *   2. A 15 s watchdog interval. The monitor's steady cadence doubles
 *      as its heartbeat - a Source that stays spawned past
 *      MonitorSilentThresholdMs without an accepted report inside that
 *      threshold has a stopped (or killed) monitor and is reported as
 *      MonitorSilent, throttled to once per 120 s. Sources that leave
 *      the Spawned phase legitimately (/changecharacter, /logout) have
 *      their entry evicted so the next spawn restarts the grace
 *      window; the PlayerSessionService playerDropped dispatcher
 *      evicts everything via Evict.
 */
export class AnticheatController {
  private readonly Log = Logger.New('AnticheatCtrl');
  private readonly Entries = new Map<number, MonitorEntry>();

  /**
   * How often the heartbeat watchdog sweeps. Deliberately shorter than
   * MonitorSilentThresholdMs so a stopped monitor is noticed within one
   * tick of crossing the threshold rather than up to a full period late.
   */
  private readonly WatchdogIntervalMs = 15_000;
  /**
   * Per-Source, per-detection score throttle. The client reports every
   * 10 s, so a persistent state (night vision left on) would otherwise
   * score six times a minute against policy weights tuned for one.
   */
  private readonly FlagThrottleMs = 60_000;
  /**
   * Longer throttle for MonitorSilent specifically. A silent monitor
   * stays silent, so without this every watchdog tick past the threshold
   * would re-report the same one condition.
   */
  private readonly SilentThrottleMs = 120_000;
  /** A flood of malformed / over-cadence reports must not flood the log. */
  private readonly RejectWarnThrottleMs = 60_000;

  constructor(
    private readonly State: PlayerStateService,
    private readonly Anticheat: AnticheatService,
  ) {
    onNet(NetEvents.AnticheatMonitorReport, this.OnMonitorReport);
    setInterval((): void => {
      this.OnWatchdogTick();
    }, this.WatchdogIntervalMs);
    this.Log.Debug('Handlers registered (AnticheatMonitorReport, watchdog interval)');
  }

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Drops the heartbeat + throttle entry.
   */
  Evict(Source: number): void {
    this.Entries.delete(Source);
  }

  // ── Report ingest ────────────────────────────────────────────────

  /**
   * A heartbeat from the client-side monitor.
   *
   * Arrow-function field so `this` survives being handed to `onNet`.
   * Payload is typed `unknown` and validated here because a cheating
   * client can send anything - or, more usefully, nothing at all, which
   * the watchdog treats as its own signal.
   */
  private OnMonitorReport = (Payload: unknown): void => {
    const Src = source;
    if (this.State.Get(Src)?.Phase !== 'Spawned') return;
    const Now = Date.now();
    const Entry = this.UpsertEntry(Src, Now);
    if (Entry.LastReportMs !== 0 && Now - Entry.LastReportMs < MonitorReportMinIntervalMs) {
      this.WarnRejection(Src, Entry, Now, 'over cadence');
      return;
    }
    const Report = NormaliseMonitorReport(Payload);
    if (Report === null) {
      this.WarnRejection(Src, Entry, Now, 'bad payload');
      return;
    }
    // Only a structurally valid report at a sane cadence feeds the
    // heartbeat - garbage must not keep a killed monitor "alive".
    Entry.LastReportMs = Now;

    this.MaybeReport(Src, Entry, Now, 'NightVision', Report.NightVision, {});
    this.MaybeReport(Src, Entry, Now, 'ThermalVision', Report.ThermalVision, {});
    this.MaybeReport(Src, Entry, Now, 'ClientInvincibility', Report.ClientInvincibility, {});
    this.MaybeReport(Src, Entry, Now, 'FreeCam', Report.FreeCamDistance !== null, {
      DistanceMeters: Report.FreeCamDistance,
    });
    this.MaybeReport(Src, Entry, Now, 'AimAssistOn', Report.AimAssistOn, {
      AimState: Report.AimState,
    });
    this.MaybeReport(Src, Entry, Now, 'InfiniteStamina', Report.InfiniteStamina, {});
    this.MaybeReport(Src, Entry, Now, 'OverMaxClip', Report.OverMaxClip, {
      ClipAmmo: Report.ClipAmmo,
      ClipMax: Report.ClipMax,
    });
    this.MaybeReport(Src, Entry, Now, 'RagdollHack', Report.RagdollHack, {});
    this.MaybeReport(Src, Entry, Now, 'PedAlphaTampering', Report.PedAlphaTampering, {
      PedAlpha: Report.PedAlpha,
    });
  };

  // ── Heartbeat watchdog ───────────────────────────────────────────

  /**
   * Check that each monitored client is still sending heartbeats.
   *
   * A silent client is itself a signal: the monitor is part of the
   * resource, so heartbeats stopping while the player stays connected
   * suggests it was disabled or stripped.
   */
  private OnWatchdogTick(): void {
    const Now = Date.now();
    for (const Src of this.State.GetAllSources()) {
      if (this.State.Get(Src)?.Phase !== 'Spawned') {
        // Legitimately out of the world (selector / auth shell) - the
        // client monitor stops by design. Evict so the next spawn
        // restarts the grace window from zero.
        this.Entries.delete(Src);
        continue;
      }
      const Entry = this.UpsertEntry(Src, Now);
      const SilentSinceMs = Entry.LastReportMs !== 0 ? Entry.LastReportMs : Entry.SpawnedSinceMs;
      const SilentForMs = Now - SilentSinceMs;
      if (SilentForMs < MonitorSilentThresholdMs) continue;
      if (Now - Entry.LastSilentReportMs < this.SilentThrottleMs) continue;
      Entry.LastSilentReportMs = Now;
      this.Anticheat.Report(Src, 'MonitorSilent', { SilentForMs });
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Emit a rejection warn at most once per RejectWarnThrottleMs per
   * Source, folding the suppressed count into the next emitted line - a
   * client spamming malformed packets costs one log line per minute,
   * not one per packet.
   */
  private WarnRejection(Src: number, Entry: MonitorEntry, Now: number, Reason: string): void {
    if (Now - Entry.LastRejectWarnMs < this.RejectWarnThrottleMs) {
      Entry.SuppressedRejectWarns += 1;
      return;
    }
    const Suppressed = Entry.SuppressedRejectWarns;
    Entry.SuppressedRejectWarns = 0;
    Entry.LastRejectWarnMs = Now;
    const Tail = Suppressed > 0 ? ` (+${Suppressed} suppressed)` : '';
    this.Log.Warn(`Monitor report rejected (${Reason}) - source=${Src}${Tail}`);
  }

  /** Score a flagged detection through the per-Source, per-type throttle. */
  private MaybeReport(
    Src: number,
    Entry: MonitorEntry,
    Now: number,
    Type: MonitorDetectionType,
    Flagged: boolean,
    Evidence: Record<string, unknown>,
  ): void {
    if (!Flagged) return;
    if (Now < (Entry.ThrottledUntilMs.get(Type) ?? 0)) return;
    Entry.ThrottledUntilMs.set(Type, Now + this.FlagThrottleMs);
    this.Anticheat.Report(Src, Type, Evidence);
  }

  /** Fetch or create a player's heartbeat-monitor entry. */
  private UpsertEntry(Src: number, Now: number): MonitorEntry {
    let Entry = this.Entries.get(Src);
    if (Entry === undefined) {
      Entry = {
        LastReportMs: 0,
        SpawnedSinceMs: Now,
        LastSilentReportMs: 0,
        ThrottledUntilMs: new Map(),
        LastRejectWarnMs: 0,
        SuppressedRejectWarns: 0,
      };
      this.Entries.set(Src, Entry);
    }
    return Entry;
  }
}

/**
 * Validate the hostile wire payload into the typed contract. Every
 * boolean field must be a boolean, AimState a finite number, every
 * nullable-number field null or a finite number - one mismatch drops
 * the whole report.
 */
function NormaliseMonitorReport(Payload: unknown): MonitorReport | null {
  if (typeof Payload !== 'object' || Payload === null) return null;
  const Raw = Payload as Record<string, unknown>;
  for (const Key of BooleanFields) {
    if (typeof Raw[Key] !== 'boolean') return null;
  }
  if (typeof Raw.AimState !== 'number' || !Number.isFinite(Raw.AimState)) return null;
  for (const Key of NullableNumberFields) {
    const Value = Raw[Key];
    if (Value !== null && (typeof Value !== 'number' || !Number.isFinite(Value))) return null;
  }
  return {
    NightVision: Raw.NightVision as boolean,
    ThermalVision: Raw.ThermalVision as boolean,
    ClientInvincibility: Raw.ClientInvincibility as boolean,
    FreeCamDistance: Raw.FreeCamDistance as number | null,
    AimState: Raw.AimState,
    AimAssistOn: Raw.AimAssistOn as boolean,
    InfiniteStamina: Raw.InfiniteStamina as boolean,
    OverMaxClip: Raw.OverMaxClip as boolean,
    ClipAmmo: Raw.ClipAmmo as number | null,
    ClipMax: Raw.ClipMax as number | null,
    RagdollHack: Raw.RagdollHack as boolean,
    PedAlphaTampering: Raw.PedAlphaTampering as boolean,
    PedAlpha: Raw.PedAlpha as number | null,
  };
}
