import { Logger } from '@/Util/Logger.js';
import type { Account } from '@/Data/Models/Account.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { DiscordProfile } from '@/Services/DiscordService.js';

interface UpsertContext {
  License: string;
  IP: string | null;
  SocialClubName: string | null;
}

/**
 * Account business logic. Bridges the playerJoining gate to the data layer:
 *
 *   UpsertFromDiscord(profile, context):
 *     - Look up Account by License (canonical key on every connect).
 *     - If not found: search by DiscordID (handles a player whose license
 *       rotated but who has an existing account).
 *     - If still not found: create a fresh Pending row. Pending is the
 *       hold state until the player passes the UCP roleplay quiz - the
 *       UCP flips them to Active. We never auto-promote here.
 *     - If found: refresh Discord profile + audit fields. Status is
 *       NEVER mutated by this path - Pending stays Pending until UCP,
 *       Banned stays Banned until manually lifted.
 *
 * Email is intentionally NOT set: bot-token /users/{id} doesn't return
 * email. The column stays NULL until/unless we wire an explicit OAuth
 * upgrade flow later.
 */
export class AccountService {
  private readonly Log = Logger.New('Account');

  constructor(private readonly Accounts: AccountRepository) {}

  async UpsertFromDiscord(Profile: DiscordProfile, Context: UpsertContext): Promise<Account> {
    const Now = new Date();

    let Account = await this.Accounts.FindByLicense(Context.License);
    if (Account === null) {
      Account = await this.Accounts.FindByDiscordID(Profile.ID);
    }

    if (Account === null) {
      const Created = await this.Accounts.Create({
        License: Context.License,
        DiscordID: Profile.ID,
        DiscordUsername: Profile.Username,
        DiscordDisplayName: Profile.DisplayName,
        DiscordAvatar: Profile.AvatarHash,
        LastSocialClubName: Context.SocialClubName,
        LastIP: Context.IP,
        RegistrationIP: Context.IP,
        Status: 'Pending',
        LastOAuthAt: Now,
        FirstLoginAt: Now,
        LastLoginAt: Now,
      });
      this.Log.Info(`Created account id=${Created.ID} discord=${Profile.ID}`);
      return Created;
    }

    // Existing row: refresh Discord profile + audit fields. Status is owned
    // by external systems (UCP quiz flips Pending -> Active, admins set
    // Banned) - this path never mutates it.
    Account.DiscordID = Profile.ID;
    Account.DiscordUsername = Profile.Username;
    Account.DiscordDisplayName = Profile.DisplayName;
    Account.DiscordAvatar = Profile.AvatarHash;
    if (Context.SocialClubName !== null) Account.LastSocialClubName = Context.SocialClubName;
    if (Context.IP !== null) Account.LastIP = Context.IP;
    Account.LastOAuthAt = Now;
    if (Account.FirstLoginAt === null) Account.FirstLoginAt = Now;
    Account.LastLoginAt = Now;

    await Account.save();
    this.Log.Debug(`Updated account id=${Account.ID} discord=${Profile.ID} status=${Account.Status}`);
    return Account;
  }
}
