import { Logger } from '@/Util/Logger.js';
import type { Deferrals } from './Deferrals.js';
import type { IQueueService } from './IQueueService.js';

declare function GetConvarInt(VarName: string, Default: number): number;
declare function GetNumPlayerIndices(): number;
declare function setTick(Callback: () => void): number;
declare function clearTick(TickId: number): void;

interface QueueEntry {
  Source: number;
  Deferrals: Deferrals;
  Resolve: () => void;
  Reject: (Err: Error) => void;
  EnqueuedAt: number;
}

/**
 * Pure FIFO queue. No tiers, no Discord, no reserved slots yet - that
 * scaffolding lands when the premium/staff feature does. The architecture
 * is intentionally narrow so the upgrade path is "add a tier field +
 * insert at the right index" rather than a rewrite.
 *
 * Slot accounting:
 *   `GetNumPlayerIndices()` counts players FXServer has already accepted,
 *   but a player who just got `deferrals.done()` won't appear there for a
 *   few hundred ms (they're still mid-handshake). `InFlight` covers that
 *   gap.
 *
 *   InFlight is intentionally an UNKEYED FIFO of timestamps, not a Map<Source,
 *   ...>: the `source` global FXServer sets during `playerConnecting` is a
 *   temp connection id (65535+N) but during `playerJoining` it's the final
 *   player id (1, 2, ...), and the two never correlate. Treating in-flight
 *   as a counter sidesteps the mismatch and is sufficient for capacity
 *   accounting.
 *
 * The ticker runs once per second:
 *   - admits AT MOST ONE waiting player per tick (over-admission would
 *     overrun `sv_maxclients` at high churn)
 *   - refreshes the position-update message for everyone still waiting
 *   - prunes stale InFlight entries (player dropped during handshake)
 */
export class QueueService implements IQueueService {
  private readonly Log = Logger.New('Queue');
  private readonly Queue: QueueEntry[] = [];
  private readonly InFlight: number[] = [];
  private readonly MaxClients: number;
  private readonly TickIntervalMs = 1000;
  private readonly InFlightTimeoutMs = 30_000;
  private TickHandle: number | null = null;
  private LastTickAt = 0;

  constructor() {
    this.MaxClients = GetConvarInt('sv_maxclients', 48);
    this.Log.Info(`Initialised - sv_maxclients=${this.MaxClients}`);
    this.StartTicker();
  }

  /**
   * Two paths, intentionally asymmetric:
   *
   *   Fast path (room available, queue empty) - DO NOT touch deferrals at all.
   *     The handler returns synchronously without calling defer/done; FXServer
   *     then auto-admits. Calling defer->done synchronously in the same
   *     handler invocation SIGSEGVs the mono dispatcher; the only safe
   *     "instant admit" is to leave deferrals untouched. See
   *     [[fxserver-crash-dumps-recurse]].
   *
   *   Slow path (must wait) - call defer() + update() in the handler, then
   *     queue the entry. The 1Hz ticker pops one entry per tick and calls
   *     done() asynchronously, which is the supported defer->done timing.
   */
  Admit(Source: number, Deferrals: Deferrals): Promise<void> {
    if (this.Queue.length === 0 && this.TotalPotentialActive() < this.MaxClients) {
      this.InFlight.push(Date.now());
      this.Log.Info(`Admit direct - source=${Source} active=${this.TotalPotentialActive()}/${this.MaxClients}`);
      return Promise.resolve();
    }

    Deferrals.Defer();
    Deferrals.Update('Server full. Joining queue...');

    return new Promise<void>((Resolve, Reject) => {
      const Entry: QueueEntry = { Source, Deferrals, Resolve, Reject, EnqueuedAt: Date.now() };
      this.Queue.push(Entry);
      const Position = this.Queue.length;
      Deferrals.Update(`Server full. Queue position ${Position} / ${Position}.`);
      this.Log.Info(`Queued - source=${Source} position=${Position}`);
    });
  }

  Remove(Source: number): void {
    const Idx = this.Queue.findIndex((E) => E.Source === Source);
    if (Idx >= 0) {
      const [Entry] = this.Queue.splice(Idx, 1) as [QueueEntry];
      Entry.Reject(new Error('Player dropped before admission'));
      this.Log.Info(`Removed from queue - source=${Source}`);
    }
  }

  NotifyJoined(): void {
    // Pop the oldest in-flight slot. Players join in the order they were
    // admitted, so FIFO matches reality even without per-source keying.
    const Stamp = this.InFlight.shift();
    if (Stamp !== undefined) {
      this.Log.Info(`In-flight cleared (joined) - waited=${Date.now() - Stamp}ms remaining=${this.InFlight.length}`);
    }
  }

  Size(): number {
    return this.Queue.length;
  }

  private TotalPotentialActive(): number {
    return GetNumPlayerIndices() + this.InFlight.length;
  }

  private StartTicker(): void {
    if (this.TickHandle !== null) return;
    this.TickHandle = setTick(() => {
      const Now = Date.now();
      if (Now - this.LastTickAt < this.TickIntervalMs) return;
      this.LastTickAt = Now;
      this.PruneInFlight();
      this.AdmitOne();
      this.BroadcastPositions();
    });
  }

  private AdmitOne(): void {
    if (this.Queue.length === 0) return;
    if (this.TotalPotentialActive() >= this.MaxClients) return;
    const Entry = this.Queue.shift();
    if (Entry === undefined) return;
    this.InFlight.push(Date.now());
    Entry.Deferrals.Done();
    Entry.Resolve();
    this.Log.Info(`Admit from queue - source=${Entry.Source} waited=${Date.now() - Entry.EnqueuedAt}ms`);
  }

  private BroadcastPositions(): void {
    const Total = this.Queue.length;
    if (Total === 0) return;
    for (let I = 0; I < Total; I += 1) {
      const Entry = this.Queue[I];
      if (Entry === undefined) continue;
      Entry.Deferrals.Update(`Server full. Queue position ${I + 1} / ${Total}.`);
    }
  }

  private PruneInFlight(): void {
    const Now = Date.now();
    // FIFO of timestamps - only the head can be the oldest, drain until
    // the next entry is fresh.
    while (this.InFlight.length > 0) {
      const Head = this.InFlight[0];
      if (Head === undefined || Now - Head <= this.InFlightTimeoutMs) return;
      this.InFlight.shift();
      this.Log.Warn(`In-flight timeout - dropped during handshake (age=${Now - Head}ms)`);
    }
  }
}
