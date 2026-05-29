/**
 * Pure DOM helpers for the SPA's light/dark theme. State lives in the
 * Settings store (UI/Src/Stores/Settings.ts) and is persisted server-
 * side on `accounts.settings` JSON; this module just paints the result.
 *
 * Three modes:
 *   - Light:  always light, ignores OS preference
 *   - Dark:   always dark, ignores OS preference
 *   - System: follows `prefers-color-scheme`, re-applies if it changes
 *
 * Note: CEF inside FiveM may not honour OS dark-mode reliably (the
 * `color-scheme: normal` in Style.css forces a neutral compositor),
 * but the matchMedia query still resolves to the system value when
 * available - System falls back to Light otherwise.
 */
import type { ThemeMode } from '@Shared/Constants/AccountSettings';

/** True if the OS / CEF reports a dark colour-scheme preference. */
export function SystemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Resolve a mode to an effective dark/light. */
export function ResolveIsDark(Mode: ThemeMode): boolean {
  if (Mode === 'Dark') return true;
  if (Mode === 'Light') return false;
  return SystemPrefersDark();
}

/** Apply (or remove) the `.dark` class on `<html>` for the given mode. */
export function ApplyTheme(Mode: ThemeMode): void {
  const IsDark = ResolveIsDark(Mode);
  document.documentElement.classList.toggle('dark', IsDark);
}

/**
 * First-paint cache key. Mirrors UI/Src/Stores/Settings.ts so the
 * pre-mount InitializeTheme() call (Main.ts) and the store init read
 * the same source.
 */
const CacheKey = 'Roleplay.Settings';

function ReadCachedMode(): ThemeMode {
  try {
    const Raw = localStorage.getItem(CacheKey);
    if (Raw === null) return 'System';
    const Parsed = JSON.parse(Raw) as { ThemeMode?: ThemeMode };
    if (Parsed?.ThemeMode === 'Light' || Parsed?.ThemeMode === 'Dark' || Parsed?.ThemeMode === 'System') {
      return Parsed.ThemeMode;
    }
  } catch {
    // localStorage can throw in CEF when the scheme is unsupported.
  }
  return 'System';
}

let SystemMediaListenerInstalled = false;
let CurrentMode: ThemeMode = 'System';

/**
 * One-shot initializer. Called from Main.ts BEFORE the SPA mounts so
 * the first paint is already on the user's chosen theme. Installs a
 * `prefers-color-scheme` listener so System mode reacts live.
 */
export function InitializeTheme(): void {
  CurrentMode = ReadCachedMode();
  ApplyTheme(CurrentMode);

  if (SystemMediaListenerInstalled) return;
  SystemMediaListenerInstalled = true;

  try {
    const Query = window.matchMedia('(prefers-color-scheme: dark)');
    const OnChange = (): void => {
      if (CurrentMode === 'System') ApplyTheme('System');
    };
    if (typeof Query.addEventListener === 'function') {
      Query.addEventListener('change', OnChange);
    } else if (typeof (Query as MediaQueryList).addListener === 'function') {
      (Query as MediaQueryList).addListener(OnChange);
    }
  } catch {
    // matchMedia not supported in this CEF build - System will pin to Light.
  }
}

/**
 * Called by the Settings store whenever the resolved ThemeMode changes
 * so the matchMedia listener has the latest mode to gate against.
 */
export function SyncCurrentMode(Next: ThemeMode): void {
  CurrentMode = Next;
}
