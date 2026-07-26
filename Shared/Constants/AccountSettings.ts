/**
 * Per-account preferences persisted server-side on the `accounts.settings`
 * JSON column. Shared across Backend (read + merge-write), Frontend (carry
 * the AuthSuccess payload through), and UI (single source of truth for
 * the settings panel; localStorage acts as a first-paint cache only).
 *
 * Adding a new setting:
 *   1. Extend the AccountSettings interface below with `Key?: Type`.
 *   2. Add a canonical default to DefaultAccountSettings.
 *   3. Extend the SettingsSchema zod object with a matching .optional()
 *      validator (Backend/Src/Services/AccountSettingsService).
 *
 * No DB migration is required - the JSON column carries arbitrary keys
 * and lazy-merge against DefaultAccountSettings means existing rows
 * inherit the new default until the user changes it.
 */

/**
 * SPA colour scheme. 'System' defers to the CEF browser's
 * prefers-color-scheme rather than storing a resolved value, so a player
 * who changes their OS theme mid-session is followed without a re-save.
 */
export type ThemeMode = 'Light' | 'Dark' | 'System';

/** Runtime list of ThemeMode, for validation and for the settings picker. */
export const ThemeModes: readonly ThemeMode[] = ['Light', 'Dark', 'System'];

/**
 * Per-account preferences, persisted as a single JSON column.
 *
 * Every field is optional on purpose: a stored row only carries the keys
 * the player has actually changed, and everything else resolves from
 * DefaultAccountSettings at read time. That is what lets a new setting
 * ship without a migration - existing rows simply have no key for it and
 * inherit the default.
 *
 * The corollary is that consumers must not read this type directly when
 * they need a value; go through ResolveAccountSettings, or an unset key
 * reads as undefined rather than as its default.
 */
export interface AccountSettings {
  /** Light / Dark / System (follows OS prefers-color-scheme). */
  ThemeMode?: ThemeMode;
  /** Render `[HH:MM:SS]` prefix on every chat row. (/toggle timestamp) */
  ChatTimestamp?: boolean;
  /** Show the chat overlay at all. (/toggle chat) */
  ChatVisible?: boolean;
  /** Show the remaining-character counter in the input bar.
   *  (/toggle charactercounter, alias /toggle counter) */
  ChatCharacterCounter?: boolean;
  /** Paint a solid black backdrop behind chat for screenshots.
   *  (/toggle blindfold) */
  ChatBlindfold?: boolean;
  /** Chat font scale multiplier (0.5 - 1.5). (/fontsize <value>) */
  ChatFontSize?: number;
  /** Visible row count in the chat overlay (5 - 40). (/pagesize <value>) */
  ChatPageSize?: number;
  /** Render your own nametag above your own ped. (/toggle selfnametag,
   *  alias /toggle selftag) */
  NametagSelfVisible?: boolean;
  /** Show the `(<source-id>)` suffix on every nametag. (/toggle
   *  nametagid, alias /toggle tagid) */
  NametagIDVisible?: boolean;
}

/**
 * Defaults applied at every read. Changing a value here updates the
 * effective default for every account that hasn't explicitly opted out,
 * which is usually what you want for soft preferences.
 */
export const DefaultAccountSettings: Required<AccountSettings> = {
  ThemeMode: 'System',
  ChatTimestamp: false,
  ChatVisible: true,
  ChatCharacterCounter: true,
  ChatBlindfold: false,
  ChatFontSize: 0.65,
  ChatPageSize: 20,
  NametagSelfVisible: false,
  NametagIDVisible: true,
};

/**
 * Merge stored + incoming partials over the defaults. Same shape on
 * Backend and UI so the resolved object is identical on both sides.
 */
export function ResolveAccountSettings(
  Stored: AccountSettings | null | undefined,
  Incoming: AccountSettings | null | undefined = null,
): Required<AccountSettings> {
  return {
    ...DefaultAccountSettings,
    ...(Stored ?? {}),
    ...(Incoming ?? {}),
  };
}
