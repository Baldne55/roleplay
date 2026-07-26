/**
 * Per-source token bucket for chat submissions. One bucket per FXServer
 * Source; lifetime is per-connection.
 *
 *   Capacity = 5 tokens
 *   Refill   = 1 token / 400 ms
 *
 * Burst of 5 is generous enough for a roleplayer typing /me + /do + /b
 * in quick succession; sustained 400ms-per-message matches lc-rp's
 * server-side anti-spam floor.
 *
 * No persistence, no decay-while-offline math - Evict on playerDropped
 * drops the bucket, and a fresh connection starts at capacity.
 */
/** Burst allowance - a full bucket permits five messages back to back. */
const Capacity = 5;
/** Sustained floor: one token back every 400 ms once the burst is spent. */
const RefillIntervalMs = 400;

/**
 * Token-bucket state for one Source.
 *
 * Refilled lazily from `LastRefillAt` on read rather than by a timer, so
 * an idle player costs nothing and there is no sweep to schedule.
 */
interface Bucket {
  Tokens: number;
  LastRefillAt: number;
}

/**
 * The limiter itself - see the file header for the policy and its
 * rationale. Holds one lazily-refilled Bucket per Source and nothing
 * else; it has no dependencies and no I/O, which is what lets
 * ChatController call TryConsume on the hot path before any other work.
 */
export class ChatRateLimiter {
  private readonly Buckets = new Map<number, Bucket>();

  /**
   * Consume one token if available. Returns true if the submission may
   * proceed, false if the bucket is exhausted.
   */
  TryConsume(Source: number): boolean {
    const Now = Date.now();
    let Bucket = this.Buckets.get(Source);
    if (Bucket === undefined) {
      Bucket = { Tokens: Capacity, LastRefillAt: Now };
      this.Buckets.set(Source, Bucket);
    }

    const Elapsed = Now - Bucket.LastRefillAt;
    if (Elapsed >= RefillIntervalMs) {
      const Granted = Math.floor(Elapsed / RefillIntervalMs);
      Bucket.Tokens = Math.min(Capacity, Bucket.Tokens + Granted);
      Bucket.LastRefillAt += Granted * RefillIntervalMs;
    }

    if (Bucket.Tokens <= 0) return false;
    Bucket.Tokens -= 1;
    return true;
  }

  /**
   * Drop a disconnected player's bucket. Called from the session teardown
   * so the map does not grow for the process lifetime; also means a
   * reconnecting player starts with a full bucket rather than inheriting
   * a throttled one from a stale Source id.
   */
  Evict(Source: number): void {
    this.Buckets.delete(Source);
  }
}
