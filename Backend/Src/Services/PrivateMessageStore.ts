/**
 * Per-Source state for the /pm / /reply / /blockpm / /unblockpm cluster.
 *
 *   - LastFrom: who last PMed each Source. Drives /reply. Source-keyed
 *     so a fresh connection on the same Source starts clean.
 *
 *   - Blocks: per-AccountID set of blocked AccountIDs. Keyed by Account
 *     (not Source) so a block survives the blocker's reconnect AND
 *     correctly identifies the blocked target even if their Source
 *     changes. The block is one-way: A blocking B means A's view drops
 *     PMs from B; B can still see PMs they receive from A. ragemp
 *     parity.
 *
 * Evict is invoked by the PlayerSessionService playerDropped dispatcher
 * to drop the Source-keyed entry; the AccountID-keyed Blocks persist
 * across reconnects on the same account.
 */
export class PrivateMessageStore {
  private readonly LastFrom = new Map<number, number>();
  /** AccountID (blocker) -> Set<AccountID> (blocked). */
  private readonly Blocks = new Map<string, Set<string>>();

  /** Remember who last messaged whom, so the recipient can `/reply`. */
  Record(Sender: number, Recipient: number): void {
    this.LastFrom.set(Recipient, Sender);
  }

  /**
   * The Source that last PMed this player - the `/reply` target. Null
   * when nobody has, or when the binding was evicted on their disconnect.
   */
  LastSenderTo(Source: number): number | null {
    return this.LastFrom.get(Source) ?? null;
  }

  /**
   * Add a block: `BlockerAccount` no longer sees PMs from
   * `TargetAccount`. Returns false when the block already existed.
   */
  AddBlock(BlockerAccount: string, TargetAccount: string): boolean {
    let Blocked = this.Blocks.get(BlockerAccount);
    if (Blocked === undefined) {
      Blocked = new Set();
      this.Blocks.set(BlockerAccount, Blocked);
    }
    if (Blocked.has(TargetAccount)) return false;
    Blocked.add(TargetAccount);
    return true;
  }

  /**
   * Remove a block. Returns false when there was no block to remove.
   */
  RemoveBlock(BlockerAccount: string, TargetAccount: string): boolean {
    const Blocked = this.Blocks.get(BlockerAccount);
    if (Blocked === undefined) return false;
    return Blocked.delete(TargetAccount);
  }

  /**
   * True when `BlockerAccount` is blocking `TargetAccount`. Used by the
   * /pm and /reply Run handlers to skip delivery while still acking to
   * the sender so the block is invisible (sender does not learn they
   * have been blocked - intentional, matches ragemp / lc-rp norms).
   */
  IsBlocked(BlockerAccount: string, TargetAccount: string): boolean {
    return this.Blocks.get(BlockerAccount)?.has(TargetAccount) ?? false;
  }

  /**
   * Drop a disconnected player's bindings, in both directions.
   *
   * Both matter: without it, a reconnecting player inheriting the Source
   * id would receive replies meant for whoever held it before.
   */
  Evict(Source: number): void {
    this.LastFrom.delete(Source);
    for (const [Key, Value] of this.LastFrom.entries()) {
      if (Value === Source) this.LastFrom.delete(Key);
    }
    // Blocks intentionally NOT evicted - they are AccountID-keyed and
    // survive reconnect by design.
  }
}
