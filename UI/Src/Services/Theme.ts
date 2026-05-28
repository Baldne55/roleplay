/**
 * Theme service. Owns the `.dark` class on `<html>` and persists the
 * user's choice across reconnects via localStorage.
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

export type ThemeMode = 'Light' | 'Dark' | 'System';

export const ThemeModes: readonly ThemeMode[] = ['Light', 'Dark', 'System'];

const StorageKey = 'Roleplay.Theme.Mode';

/**
 * Returns the saved mode (or 'System' on first run / unparsable value).
 * Safe to call before the SPA mounts.
 */
export function LoadSavedMode(): ThemeMode {
  try {
    const Raw = localStorage.getItem(StorageKey);
    if (Raw === 'Light' || Raw === 'Dark' || Raw === 'System') return Raw;
  } catch {
    // localStorage can throw in CEF when the scheme is unsupported.
  }
  return 'System';
}

export function SaveMode(Mode: ThemeMode): void {
  try {
    localStorage.setItem(StorageKey, Mode);
  } catch {
    // ignore - choice still applies for the current session
  }
}

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

let SystemMediaListenerInstalled = false;
let CurrentMode: ThemeMode = 'System';

/**
 * One-shot initializer. Loads the saved mode, applies it, and installs
 * a `prefers-color-scheme` listener so the System mode reacts live.
 */
export function InitializeTheme(): void {
  CurrentMode = LoadSavedMode();
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

/** Change the active mode (persists + re-applies). */
export function SetMode(Mode: ThemeMode): void {
  CurrentMode = Mode;
  SaveMode(Mode);
  ApplyTheme(Mode);
}

export function GetMode(): ThemeMode {
  return CurrentMode;
}
