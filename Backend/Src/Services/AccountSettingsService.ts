import { z } from 'zod';
import {
  ResolveAccountSettings,
  type AccountSettings,
} from '@Shared/Constants/AccountSettings.js';
import { Logger } from '@/Util/Logger.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';

/**
 * Per-key validator. Every field is `.optional()` because the wire
 * payload is a partial - the player toggles one setting at a time. Each
 * key here mirrors the AccountSettings interface in Shared.
 *
 * Adding a new setting:
 *   1. Extend AccountSettings in Shared/Constants/AccountSettings.ts.
 *   2. Add a matching `.optional()` validator below.
 *   3. Add a sane default to DefaultAccountSettings.
 *
 * Literal unions are written out (not `z.enum(ThemeModes as ...)`)
 * because tsconfig's `exactOptionalPropertyTypes` rejects the generic
 * string-tuple form when spreading into AccountSettings.
 */
const SettingsSchema = z
  .object({
    ThemeMode: z
      .union([z.literal('Light'), z.literal('Dark'), z.literal('System')])
      .optional(),
    ChatTimestamp: z.boolean().optional(),
    ChatVisible: z.boolean().optional(),
    ChatCharacterCounter: z.boolean().optional(),
    ChatBlindfold: z.boolean().optional(),
    ChatFontSize: z.number().min(0.5).max(1.5).optional(),
    ChatPageSize: z.number().int().min(5).max(40).optional(),
    NametagSelfVisible: z.boolean().optional(),
    NametagIDVisible: z.boolean().optional(),
  })
  .strict();

/**
 * Service-layer settings access. Two concerns:
 *
 *   - Get: return the resolved (defaults-merged) settings for an account.
 *           Callers see a fully-populated object, never a partial.
 *   - UpdateMerge: validate an incoming partial, merge over the current
 *           stored value, write back. Returns the resolved post-merge
 *           snapshot so the caller can echo it back to the client.
 *
 * Validation drops unknown keys (.strict()) - a malicious payload with
 * `__proto__` or random junk gets rejected with a typed error rather
 * than persisted into the JSON column.
 */
export class AccountSettingsService {
  private readonly Log = Logger.New('AccountSettings');

  constructor(private readonly Accounts: AccountRepository) {}

  /**
   * Read an account's settings, merged over the defaults.
   *
   * Always returns a complete object - a missing account or a null
   * settings column yields defaults rather than null. That merge is what
   * lets a newly added setting apply to existing rows without a
   * backfill migration.
   */
  async Get(AccountID: string): Promise<AccountSettings> {
    const Account = await this.Accounts.FindByID(AccountID);
    if (Account === null) return ResolveAccountSettings(null);
    return ResolveAccountSettings(Account.Settings);
  }

  /**
   * Validate + merge + persist. The merge is shallow - settings keys are
   * primitives today, so deep merge is unnecessary. Returns the post-
   * merge resolved snapshot.
   */
  async UpdateMerge(
    AccountID: string,
    Incoming: unknown,
  ): Promise<AccountSettings> {
    const Parsed = SettingsSchema.safeParse(Incoming);
    if (!Parsed.success) {
      this.Log.Warn(`UpdateMerge rejected invalid payload for account=${AccountID}`, {
        Errors: Parsed.error.issues.map((I) => I.path.join('.') + ': ' + I.message),
      });
      throw new AccountSettingsValidationError('Invalid settings payload.');
    }

    const Account = await this.Accounts.FindByID(AccountID);
    if (Account === null) throw new AccountSettingsValidationError('Account not found.');

    // exactOptionalPropertyTypes: zod's optional fields are typed as
    // `T | undefined`, which doesn't merge cleanly into AccountSettings
    // (where optional means present-or-absent). Strip undefined-valued
    // keys before spreading so the resulting JSON column only carries
    // real values.
    const Clean: Record<string, unknown> = {};
    for (const [Key, Value] of Object.entries(Parsed.data)) {
      if (Value !== undefined) Clean[Key] = Value;
    }
    const Merged: AccountSettings = {
      ...(Account.Settings ?? {}),
      ...(Clean as AccountSettings),
    };
    await this.Accounts.UpdateSettings(AccountID, Merged);
    this.Log.Debug(`Updated settings for account=${AccountID}`, { Keys: Object.keys(Parsed.data) });
    return ResolveAccountSettings(Merged);
  }
}

/**
 * Raised when a settings write fails validation. `Reason` is
 * player-readable, so controllers can surface it directly rather than
 * mapping it to a generic message.
 */
export class AccountSettingsValidationError extends Error {
  constructor(public readonly Reason: string) {
    super(Reason);
    this.name = 'AccountSettingsValidationError';
  }
}
