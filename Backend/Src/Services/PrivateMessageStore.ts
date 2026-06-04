import { Logger } from '@/Util/Logger.js';

declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;

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
 * Self-registers a playerDropped handler in the constructor to evict
 * the Source-keyed entry; the AccountID-keyed Blocks persist across
 * reconnects on the same account.
 */
export class PrivateMessageStore {
  private readonly Log = Logger.New('PmStore');
  private readonly LastFrom = new Map<number, number>();
  /** AccountID (blocker) -> Set<AccountID> (blocked). */
  private readonly Blocks = new Map<string, Set<string>>();

  constructor() {
    on('playerDropped', (): void => {
      const Src = source;
      this.Evict(Src);
    });
    this.Log.Debug('Handlers registered (playerDropped)');
  }

  Record(Sender: number, Recipient: number): void {
    this.LastFrom.set(Recipient, Sender);
  }

  LastSenderTo(Source: number): number | null {
    return this.LastFrom.get(Source) ?? null;
  }

  /**
   * Add a block: `BlockerAccount` no longer sees PMs from
   * `TargetAccount`. Returns false when the block already existed.
   */
  AddBlock(BlockerAccount: string, TargetAccount: string): boolean {
    let Set_ = this.Blocks.get(BlockerAccount);
    if (Set_ === undefined) {
      Set_ = new Set();
      this.Blocks.set(BlockerAccount, Set_);
    }
    if (Set_.has(TargetAccount)) return false;
    Set_.add(TargetAccount);
    return true;
  }

  /**
   * Remove a block. Returns false when there was no block to remove.
   */
  RemoveBlock(BlockerAccount: string, TargetAccount: string): boolean {
    const Set_ = this.Blocks.get(BlockerAccount);
    if (Set_ === undefined) return false;
    return Set_.delete(TargetAccount);
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

  Evict(Source: number): void {
    this.LastFrom.delete(Source);
    for (const [Key, Value] of this.LastFrom.entries()) {
      if (Value === Source) this.LastFrom.delete(Key);
    }
    // Blocks intentionally NOT evicted - they are AccountID-keyed and
    // survive reconnect by design.
  }
}
