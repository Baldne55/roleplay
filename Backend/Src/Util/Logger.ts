/**
 * Scoped logger. Per-module scope tag for greppable output.
 *
 * Threshold is sourced from the `log_level` convar (server.cfg) on first
 * use. Production should set `setr log_level "warn"` to drop the per-
 * player chatter that floods the console in dev.
 *
 * Format:
 *   29-05-2026 - 15:30:42 [INFO] [Bootstrap] message
 *
 * Usage:
 *   const Log = Logger.New('Auth');
 *   Log.Info('Player authenticated', { Source: 1 });
 *   Log.Error('OAuth failed', Err);
 */

/**
 * Severity names, ordered by LevelOrder below. Not exported: callers pick
 * a level by calling Log.Debug / Log.Info / etc., never by passing one of
 * these strings, so widening the union is a purely internal change.
 */
type LogLevel = 'Debug' | 'Info' | 'Warn' | 'Error';

/**
 * Numeric severity, ascending. A line is emitted when its own order is
 * >= the configured minimum, so raising MinLevel silences everything
 * below it.
 */
const LevelOrder: Record<LogLevel, number> = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
};

declare function GetConvar(VarName: string, Default: string): string;

/**
 * Resolve the threshold from the `log_level` convar, defaulting to Info.
 *
 * Read once at module load rather than per call. Anything unrecognised
 * falls back to Info rather than failing - a typo in server.cfg should
 * not silence logging or crash the boot.
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
 * Module-global severity floor, seeded from the convar at import time.
 * Deliberately mutable (SetMinLogLevel) and deliberately shared by every
 * Logger instance - there is no per-category level, so raising it quiets
 * the whole server at once.
 */
let MinLevel: LogLevel = ReadConvarLevel();

/** Override the level at runtime (tests, dynamic admin command, etc.). */
export function SetMinLogLevel(Level: LogLevel): void {
  MinLevel = Level;
}

/** Zero-pad to two digits for the timestamp fields. */
function Pad2(N: number): string {
  return N < 10 ? `0${N}` : String(N);
}

/**
 * `DD-MM-YYYY - HH:MM:SS` in server-local time. Fixed-width so console
 * output stays column-aligned and greppable.
 */
function FormatTimestamp(D: Date = new Date()): string {
  return (
    `${Pad2(D.getDate())}-${Pad2(D.getMonth() + 1)}-${D.getFullYear()} - ` +
    `${Pad2(D.getHours())}:${Pad2(D.getMinutes())}:${Pad2(D.getSeconds())}`
  );
}

/**
 * Compose one output line.
 *
 * `Extra` is JSON-serialised when present, inside a try/catch: a circular
 * structure or a BigInt would otherwise throw from inside a log call and
 * take down whatever was being logged about. A logger must never be the
 * thing that breaks the request.
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

/**
 * Threshold-check, format, and write to the matching console channel.
 *
 * The check happens here, which means callers have already built their
 * message and `Extra` object by the time it runs - see DebugEnabled for
 * why that matters on hot paths.
 */
function Emit(Level: LogLevel, Scope: string, Message: string, Extra?: unknown): void {
  if (LevelOrder[Level] < LevelOrder[MinLevel]) return;
  const Line = Format(Level, Scope, Message, Extra);
  if (Level === 'Error') console.error(Line);
  else if (Level === 'Warn') console.warn(Line);
  else console.log(Line);
}

/**
 * Whether a Debug line would actually be emitted at the current
 * threshold.
 *
 * The level check inside Emit runs AFTER the caller has already built
 * its arguments - a template literal is interpolated, and an `Extra`
 * object literal is allocated, before the call is even made. That is
 * free on the cold paths (boot, connect, spawn, admin commands) where
 * most of the 100-odd Debug sites live, but the handful on per-message
 * and per-discharge paths pay it on every event even in production,
 * where `log_level` is `warn`.
 *
 * Guard those sites with this:
 *
 *   if (DebugEnabled()) this.Log.Debug(`...`, { ... });
 *
 * Deliberately a function, not a cached constant - SetMinLogLevel can
 * move the threshold at runtime.
 */
export function DebugEnabled(): boolean {
  return LevelOrder.Debug >= LevelOrder[MinLevel];
}

/** A logger bound to one module's scope tag. */
export interface ScopedLogger {
  Debug: (Message: string, Extra?: unknown) => void;
  Info: (Message: string, Extra?: unknown) => void;
  Warn: (Message: string, Extra?: unknown) => void;
  Error: (Message: string, Extra?: unknown) => void;
}

/**
 * Logger factory. `New(Scope)` is called once per module at construction
 * and the result held as a field - the scope tag is what makes output
 * greppable by subsystem.
 */
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
