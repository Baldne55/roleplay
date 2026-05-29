import { Logger } from '@/Util/Logger.js';

declare function DropPlayer(PlayerSrc: string | number, Reason: string): void;

/**
 * Enforces one-active-session-per-account.
 *
 * Pattern: standard "kick the previous, accept the new". A player whose
 * client crashed mid-game can reconnect; their stale session is dropped
 * and the new one takes over. Two-tab impersonation is impossible (the
 * impersonator would just kick the real player, who would re-auth and
 * kick them back).
 *
 *   Claim(accountID, source) - returns the previous Source that owned
 *                              this account if any, AND drops that
 *                              previous Source from the server. Caller
 *                              proceeds with the new Source unconditionally.
 *
 *   Release(source)          - on playerDropped, free any account claim
 *                              this Source held.
 */
export class AccountSessionService {
  private readonly Log = Logger.New('Session');
  private readonly AccountToSource = new Map<string, number>();
  private readonly SourceToAccount = new Map<number, string>();

  Claim(AccountID: string, Source: number): void {
    const Previous = this.AccountToSource.get(AccountID);
    if (Previous !== undefined && Previous !== Source) {
      this.Log.Warn(`Account ${AccountID} re-claimed: kicking previous source=${Previous}, new=${Source}`);
      try {
        DropPlayer(Previous, 'Your account signed in from another session.');
      } catch (Err: unknown) {
        this.Log.Warn(`DropPlayer(${Previous}) threw`, { Err: String(Err) });
      }
      this.SourceToAccount.delete(Previous);
    }
    this.AccountToSource.set(AccountID, Source);
    this.SourceToAccount.set(Source, AccountID);
    this.Log.Debug(`Claimed account=${AccountID} for source=${Source}`);
  }

  Release(Source: number): void {
    const AccountID = this.SourceToAccount.get(Source);
    if (AccountID === undefined) return;
    this.SourceToAccount.delete(Source);
    if (this.AccountToSource.get(AccountID) === Source) {
      this.AccountToSource.delete(AccountID);
      this.Log.Debug(`Released account=${AccountID} (source=${Source})`);
    }
  }
}
