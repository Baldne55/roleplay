import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  DefaultAccountSettings,
  ResolveAccountSettings,
  type AccountSettings,
  type ThemeMode,
} from '@Shared/Constants/AccountSettings';
import { ApplyTheme, SyncCurrentMode } from '@/Services/Theme';

/**
 * Per-account preferences. Source of truth is the server (`accounts.settings`
 * JSON column); localStorage acts as a first-paint cache so the SPA doesn't
 * flash the wrong theme between mount and AuthCompleted.
 *
 * Write-through pattern:
 *   - Read on mount (Pinia init): localStorage cache -> store.
 *   - On AuthCompleted (NuiInbox -> Hydrate): server snapshot wins,
 *     overwrites store + cache, re-applies derived DOM state (theme).
 *   - On user toggle (SetThemeMode):
 *       1. Optimistically update store + cache + DOM.
 *       2. POST 'Settings:Update' so the Frontend bridges to the server.
 *       3. Server echoes via SettingsPushed -> NuiInbox -> Hydrate, which
 *          is a no-op when local + remote agree.
 */
const CacheKey = 'Roleplay.Settings';

function ReadCache(): AccountSettings {
  try {
    const Raw = localStorage.getItem(CacheKey);
    if (Raw === null) return {};
    const Parsed = JSON.parse(Raw) as unknown;
    if (typeof Parsed !== 'object' || Parsed === null) return {};
    return Parsed as AccountSettings;
  } catch {
    return {};
  }
}

function WriteCache(Settings: AccountSettings): void {
  try {
    localStorage.setItem(CacheKey, JSON.stringify(Settings));
  } catch {
    // localStorage can throw in CEF when the storage scheme is restricted.
    // The server copy still wins on next AuthCompleted, so swallow.
  }
}

export const useSettingsStore = defineStore('Settings', () => {
  // Initialise from cache so the first paint is on the user's last
  // chosen theme rather than DefaultAccountSettings.ThemeMode ('System').
  const Cached = ReadCache();
  const ThemeMode = ref<ThemeMode>(Cached.ThemeMode ?? DefaultAccountSettings.ThemeMode);
  const HasSynced = ref<boolean>(false);

  // Apply the cached theme to <html> as soon as the store mounts. Main.ts
  // already calls InitializeTheme() which reads localStorage independently;
  // re-applying here is idempotent.
  SyncCurrentMode(ThemeMode.value);
  ApplyTheme(ThemeMode.value);

  const Resolved = computed<Required<AccountSettings>>(() =>
    ResolveAccountSettings({ ThemeMode: ThemeMode.value }),
  );

  /**
   * Server pushed a fresh snapshot (initial AuthCompleted or echo after
   * an update). Overwrite local state + cache and re-apply DOM.
   */
  function Hydrate(Settings: AccountSettings): void {
    const Next = ResolveAccountSettings(Settings);
    ThemeMode.value = Next.ThemeMode;
    WriteCache({ ThemeMode: Next.ThemeMode });
    SyncCurrentMode(Next.ThemeMode);
    ApplyTheme(Next.ThemeMode);
    HasSynced.value = true;
  }

  /**
   * User picked a theme. Optimistic local update, then POST to the
   * Frontend; the server echoes back via Hydrate.
   */
  function SetThemeMode(Next: ThemeMode): void {
    if (ThemeMode.value === Next) return;
    ThemeMode.value = Next;
    WriteCache({ ThemeMode: Next });
    ApplyTheme(Next);
    void fetch('https://roleplay/Settings:Update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Settings: { ThemeMode: Next } }),
    }).catch(() => {
      // CEF-less dev run: the fetch fails silently. Local cache survives.
    });
  }

  return {
    ThemeMode,
    HasSynced,
    Resolved,
    Hydrate,
    SetThemeMode,
  };
});
