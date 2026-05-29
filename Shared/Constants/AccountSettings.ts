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

export type ThemeMode = 'Light' | 'Dark' | 'System';

export const ThemeModes: readonly ThemeMode[] = ['Light', 'Dark', 'System'];

export interface AccountSettings {
  /** Light / Dark / System (follows OS prefers-color-scheme). */
  ThemeMode?: ThemeMode;
}

/**
 * Defaults applied at every read. Changing a value here updates the
 * effective default for every account that hasn't explicitly opted out,
 * which is usually what you want for soft preferences.
 */
export const DefaultAccountSettings: Required<AccountSettings> = {
  ThemeMode: 'System',
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
