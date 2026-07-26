import type { AccountSettings } from '@Shared/Constants/AccountSettings.js';
import { Account } from '@/Data/Models/Account.js';

/**
 * Account data access. Owns all SQL touching the accounts table; services
 * call the repo so the persistence layer stays swappable (and testable).
 *
 * No business rules here - those live in AccountService. Repo methods
 * return Account instances or null, never throw on "not found".
 */
export class AccountRepository {
  /** Account by primary key. */
  FindByID(ID: string): Promise<Account | null> {
    return Account.findByPk(ID);
  }

  /**
   * Account by Rockstar license - the canonical identity lookup on join,
   * since the license is durable per installation and cannot be forged.
   */
  FindByLicense(License: string): Promise<Account | null> {
    return Account.findOne({ where: { License } });
  }

  /**
   * Account by Discord snowflake. Secondary to the license lookup - a
   * player without Discord running has none, so this can miss for
   * legitimate reasons.
   */
  FindByDiscordID(DiscordID: string): Promise<Account | null> {
    return Account.findOne({ where: { DiscordID } });
  }

  /** Insert an account row, on first-ever join for a license. */
  Create(Fields: Partial<Account>): Promise<Account> {
    return Account.create(Fields as unknown as Account);
  }

  /**
   * Replace the settings JSON for the given account. Merge semantics
   * live in AccountSettingsService - this is the dumb persistence call.
   */
  async UpdateSettings(ID: string, Settings: AccountSettings): Promise<void> {
    await Account.update({ Settings }, { where: { ID } });
  }
}
