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
  FindByID(ID: string): Promise<Account | null> {
    return Account.findByPk(ID);
  }

  FindByLicense(License: string): Promise<Account | null> {
    return Account.findOne({ where: { License } });
  }

  FindByDiscordID(DiscordID: string): Promise<Account | null> {
    return Account.findOne({ where: { DiscordID } });
  }

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
