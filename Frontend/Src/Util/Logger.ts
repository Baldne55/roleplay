/**
 * Frontend scoped logger. Same API as Backend/Src/Util/Logger.ts but client-side
 * (FiveM's V8 has `console.log` that routes to the client F8 console).
 *
 * Threshold is sourced from the `log_level` convar (replicated via `setr`
 * in server.cfg) on module init.
 *
 * Format:
 *   29-05-2026 - 15:30:42 [INFO] [Bootstrap] message
 *
 * Kept as a separate copy rather than shared through Shared/ because it
 * reaches for GetConvar, which is a runtime native - Shared code must not
 * touch natives, since it also compiles into the NUI browser bundle.
 *
 * One deliberate divergence from the server copy: there is no
 * `DebugEnabled()` here. That guard exists on the server to avoid
 * building log arguments on per-message and per-discharge paths; the
 * client has no equivalent hot Debug site, so the extra surface would be
 * unused. Add it if one appears.
 */

/**
 * Severity names, ordered by LevelOrder below. Kept identical to the
 * server copy so a line moved between the two sides keeps its level.
 */
type LogLevel = 'Debug' | 'Info' | 'Warn' | 'Error';

/** Numeric severity, ascending; a line emits when its order >= MinLevel. */
const LevelOrder: Record<LogLevel, number> = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
};

declare function GetConvar(VarName: string, Default: string): string;

/**
 * Resolve the threshold from the replicated `log_level` convar, defaulting
 * to Info. Requires `setr` (not `set`) in server.cfg - a server-only
 * convar is invisible here and every client would silently fall back.
 */
function ReadConvarLevel(): LogLevel {
  try {
    const Raw = GetConvar('log_level', 'info').toLowerCase();
    if (Raw === 'debug') return 'Debug';
    if (Raw === 'warn') return 'Warn';
    if (Raw === 'error') return 'Error';
    return 'Info';
  } catch {
    return 'Info';
  }
}

/**
 * Module-global severity floor, seeded at import time and shared by every
 * Logger instance on the client side.
 */
let MinLevel: LogLevel = ReadConvarLevel();

/** Override the level at runtime (tests, debugging a live client). */
export function SetMinLogLevel(Level: LogLevel): void {
  MinLevel = Level;
}

/** Zero-pad to two digits for the timestamp fields. */
function Pad2(N: number): string {
  return N < 10 ? `0${N}` : String(N);
}

/** `DD-MM-YYYY - HH:MM:SS` in the client's local time, fixed width. */
function FormatTimestamp(D: Date = new Date()): string {
  return (
    `${Pad2(D.getDate())}-${Pad2(D.getMonth() + 1)}-${D.getFullYear()} - ` +
    `${Pad2(D.getHours())}:${Pad2(D.getMinutes())}:${Pad2(D.getSeconds())}`
  );
}

/**
 * Compose one output line, JSON-serialising `Extra` inside a try/catch so
 * a circular structure can never turn a log call into a thrown error.
 */
function Format(Level: LogLevel, Scope: string, Message: string, Extra?: unknown): string {
  const Base = `${FormatTimestamp()} [${Level.toUpperCase()}] [${Scope}] ${Message}`;
  if (Extra === undefined) return Base;
  try {
    return `${Base} ${JSON.stringify(Extra)}`;
  } catch {
    return `${Base} [unserialisable extra]`;
  }
}

/** Threshold-check, format, and write to the F8 console channel. */
function Emit(Level: LogLevel, Scope: string, Message: string, Extra?: unknown): void {
  if (LevelOrder[Level] < LevelOrder[MinLevel]) return;
  const Line = Format(Level, Scope, Message, Extra);
  if (Level === 'Error') console.error(Line);
  else if (Level === 'Warn') console.warn(Line);
  else console.log(Line);
}

/** A logger bound to one module's scope tag. */
export interface ScopedLogger {
  Debug: (Message: string, Extra?: unknown) => void;
  Info: (Message: string, Extra?: unknown) => void;
  Warn: (Message: string, Extra?: unknown) => void;
  Error: (Message: string, Extra?: unknown) => void;
}

/** Logger factory; call once per module and hold the result. */
export const Logger = {
  New(Scope: string): ScopedLogger {
    return {
      Debug: (Message: string, Extra?: unknown): void => Emit('Debug', Scope, Message, Extra),
      Info: (Message: string, Extra?: unknown): void => Emit('Info', Scope, Message, Extra),
      Warn: (Message: string, Extra?: unknown): void => Emit('Warn', Scope, Message, Extra),
      Error: (Message: string, Extra?: unknown): void => Emit('Error', Scope, Message, Extra),
    };
  },
} as const;
