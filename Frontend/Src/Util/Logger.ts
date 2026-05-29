/**
 * Frontend scoped logger. Same API as Backend/Util/Logger.ts but client-side
 * (FiveM's V8 has `console.log` that routes to the client F8 console).
 *
 * Threshold is sourced from the `log_level` convar (replicated via `setr`
 * in server.cfg) on module init.
 *
 * Format:
 *   29-05-2026 - 15:30:42 [INFO] [Bootstrap] message
 */

type LogLevel = 'Debug' | 'Info' | 'Warn' | 'Error';

const LevelOrder: Record<LogLevel, number> = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
};

declare function GetConvar(VarName: string, Default: string): string;

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

let MinLevel: LogLevel = ReadConvarLevel();

export function SetMinLogLevel(Level: LogLevel): void {
  MinLevel = Level;
}

function Pad2(N: number): string {
  return N < 10 ? `0${N}` : String(N);
}

function FormatTimestamp(D: Date = new Date()): string {
  return (
    `${Pad2(D.getDate())}-${Pad2(D.getMonth() + 1)}-${D.getFullYear()} - ` +
    `${Pad2(D.getHours())}:${Pad2(D.getMinutes())}:${Pad2(D.getSeconds())}`
  );
}

function Format(Level: LogLevel, Scope: string, Message: string, Extra?: unknown): string {
  const Base = `${FormatTimestamp()} [${Level.toUpperCase()}] [${Scope}] ${Message}`;
  if (Extra === undefined) return Base;
  try {
    return `${Base} ${JSON.stringify(Extra)}`;
  } catch {
    return `${Base} [unserialisable extra]`;
  }
}

function Emit(Level: LogLevel, Scope: string, Message: string, Extra?: unknown): void {
  if (LevelOrder[Level] < LevelOrder[MinLevel]) return;
  const Line = Format(Level, Scope, Message, Extra);
  if (Level === 'Error') console.error(Line);
  else if (Level === 'Warn') console.warn(Line);
  else console.log(Line);
}

export interface ScopedLogger {
  Debug: (Message: string, Extra?: unknown) => void;
  Info: (Message: string, Extra?: unknown) => void;
  Warn: (Message: string, Extra?: unknown) => void;
  Error: (Message: string, Extra?: unknown) => void;
}

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
