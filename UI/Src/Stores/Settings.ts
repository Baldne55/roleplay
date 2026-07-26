import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  DefaultAccountSettings,
  ResolveAccountSettings,
  type AccountSettings,
  type ThemeMode,
} from '@Shared/Constants/AccountSettings';
import { ApplyTheme, SyncCurrentMode } from '@/Services/Theme';
import { UseChatStore } from '@/Stores/Chat';

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

/**
 * Load the locally-cached settings so the UI can paint with the player's
 * preferences before the server's copy arrives.
 *
 * Purely a first-paint optimisation - the authoritative values land with
 * AuthCompleted and overwrite whatever this returned. Any failure yields
 * `{}` and the defaults apply.
 */
function ReadCache(): AccountSettings {
  try {
    const Raw = localStorage.getItem(CacheKey);
    if (Raw === null) return {};
    const Parsed = JSON.parse(Raw) as unknown;
    if (typeof Parsed !== 'object' || Parsed === null) return {};
    return Parsed;
  } catch {
    return {};
  }
}

/**
 * Mirror settings into localStorage for the next session's first paint.
 * Never the source of truth, so a write failure is safely ignored.
 */
function WriteCache(Settings: AccountSettings): void {
  try {
    localStorage.setItem(CacheKey, JSON.stringify(Settings));
  } catch {
    // localStorage can throw in CEF when the storage scheme is restricted.
    // The server copy still wins on next AuthCompleted, so swallow.
  }
}

/**
 * Account preferences, write-through to the server.
 *
 * The localStorage cache is a first-paint optimisation ONLY - the server
 * copy always wins on the next AuthCompleted hydrate. Treat the cache as
 * disposable: it can be stale, absent, or unwritable (CEF restricts the
 * storage scheme in some configurations), and none of those are errors.
 */
export const UseSettingsStore = defineStore('Settings', () => {
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
   * an update). Overwrite local state + cache and re-apply DOM. Chat-
   * related fields are forwarded to the Chat store so the overlay is in
   * its persisted shape before the first push lands.
   */
  function Hydrate(Settings: AccountSettings): void {
    const Next = ResolveAccountSettings(Settings);
    ThemeMode.value = Next.ThemeMode;
    WriteCache({ ThemeMode: Next.ThemeMode });
    SyncCurrentMode(Next.ThemeMode);
    ApplyTheme(Next.ThemeMode);
    const Chat = UseChatStore();
    Chat.HydrateFrom({
      ChatTimestamp: Next.ChatTimestamp,
      ChatVisible: Next.ChatVisible,
      ChatCharacterCounter: Next.ChatCharacterCounter,
      ChatBlindfold: Next.ChatBlindfold,
      ChatFontSize: Next.ChatFontSize,
      ChatPageSize: Next.ChatPageSize,
    });
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
