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
const Capacity = 5;
const RefillIntervalMs = 400;

interface Bucket {
  Tokens: number;
  LastRefillAt: number;
}

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

  Evict(Source: number): void {
    this.Buckets.delete(Source);
  }
}
