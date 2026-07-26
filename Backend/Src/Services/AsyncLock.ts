import { InventoryLockTimeoutMs } from '@Shared/Constants/Inventory.js';
import { Logger } from '@/Util/Logger.js';

/**
 * Per-key async lock. Mutations against a single InventoryID serialise
 * through one queue keyed by that ID; mutations against different IDs
 * never collide. Direct port of the ragemp pattern:
 *
 *   const Release = await Lock.Acquire(InventoryID);
 *   try { ...mutation... } finally { Release(); }
 *
 * The Acquire promise resolves when the lock becomes free, or REJECTS
 * once `InventoryLockTimeoutMs` ms have elapsed. The timeout bounds how
 * long a caller waits; it does NOT reclaim the lock from whoever holds
 * it. A holder that never calls Release stalls its key permanently and
 * every later waiter fails fast against it - deliberately, since
 * force-reclaiming a live holder's lock would let two writers into the
 * same inventory. Callers must therefore release on every path:
 * acquire, then `try { ... } finally { Release(); }` with nothing that
 * can throw in between. Acquiring a second lock is exactly such a
 * throwing step - see InventoryService.AcquireOrderedLocks.
 *
 * Cross-inventory operations (`/item give`, `/container store`) acquire
 * both locks in ascending InventoryID order to prevent deadlock. The
 * service layer enforces that ordering; this class is unaware of it.
 */
export class AsyncLock {
  private readonly Log = Logger.New('AsyncLock');
  private readonly Queues = new Map<string, (() => void)[]>();

  /**
   * Acquire the lock for `Key`. Returns a release function. Always
   * call Release inside a `try { ... } finally { Release(); }` block -
   * a forgotten Release blocks every subsequent mutation against the
   * same key for the lifetime of the process, and each blocked waiter
   * only learns so after the full timeout.
   *
   * Rejects with a timeout error if the lock does not come free in
   * `InventoryLockTimeoutMs`. A rejected acquire never held the lock,
   * so there is nothing to release on that path.
   */
  async Acquire(Key: string): Promise<() => void> {
    return await new Promise<() => void>((Resolve, Reject) => {
      const Queue = this.Queues.get(Key);

      let Timeout: ReturnType<typeof setTimeout> | null = null;
      let Released = false;

      const Release = (): void => {
        if (Released) return;
        Released = true;
        if (Timeout !== null) {
          clearTimeout(Timeout);
          Timeout = null;
        }
        this.Advance(Key);
      };

      const Wait = (): void => {
        Timeout = setTimeout((): void => {
          if (Released) return;
          this.Log.Warn(`Lock acquire timeout - key=${Key}`);
          // Drop the waiter from the queue; the caller's promise
          // rejects, the queue advances to the next waiter normally.
          const Active = this.Queues.get(Key);
          if (Active !== undefined) {
            const Idx = Active.indexOf(Grant);
            if (Idx >= 0) Active.splice(Idx, 1);
          }
          Released = true;
          Reject(new Error(`AsyncLock acquire timeout for key=${Key}`));
        }, InventoryLockTimeoutMs);
      };

      const Grant = (): void => {
        if (Released) {
          // Caller already gave up via timeout; the queue should skip
          // and grant the next waiter immediately.
          this.Advance(Key);
          return;
        }
        if (Timeout !== null) {
          clearTimeout(Timeout);
          Timeout = null;
        }
        Resolve(Release);
      };

      if (Queue === undefined) {
        // Lock free. Reserve the slot with an empty queue (the head is
        // implicitly the currently-held owner) and grant.
        this.Queues.set(Key, []);
        Resolve(Release);
        return;
      }

      Queue.push(Grant);
      Wait();
    });
  }

  /** Internal: hand the lock to the next waiter or release the key entirely. */
  private Advance(Key: string): void {
    const Queue = this.Queues.get(Key);
    if (Queue === undefined) return;
    const Next = Queue.shift();
    if (Next === undefined) {
      this.Queues.delete(Key);
      return;
    }
    // Defer to the next microtask so the releasing caller's stack
    // unwinds before the next waiter's mutation runs.
    Promise.resolve().then(Next).catch((Err: unknown) => {
      this.Log.Error(`AsyncLock grant threw - key=${Key}`, { Err: String(Err) });
    });
  }
}
