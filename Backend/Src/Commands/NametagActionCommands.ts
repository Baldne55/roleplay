import { ChatColor } from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import { AssertHealthy, ChainBeforeRun } from '@/Commands/Shared/AssertHealthy.js';
import { Logger } from '@/Util/Logger.js';

declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;

/**
 * Nametag-action commands - /ame and /amy - forward-prep for the
 * floating action line that will sit above a character's nametag once
 * the overlay ships. Today the Run handler writes the formatted string
 * to the replicated state bag `Roleplay:NametagAction` and chat-acks the
 * player so they can confirm it landed; when the client-side nametag
 * overlay arrives, it reads the same key and renders without any
 * command-side change. A 5 s timer per source clears the bag back to
 * null; back-to-back sets reset the timeout cleanly.
 */

const StateKey = 'Roleplay:NametagAction';
const ClearAfterMs = 5_000;

const Timers = new Map<number, NodeJS.Timeout>();
const Log = Logger.New('NametagAction');

let HandlersRegistered = false;

export function Register(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
): void {
  EnsureHandlers();

  RegisterNametagAction(
    Registry,
    Broadcaster,
    Runtimes,
    'ame',
    'Set a roleplay action displayed above your nametag.',
    'Possessive',
    false,
  );

  RegisterNametagAction(
    Registry,
    Broadcaster,
    Runtimes,
    'amy',
    'Set a possessive roleplay action displayed above your nametag.',
    'Possessive',
    true,
  );
}

/**
 * Cleanup hook for playerDropped. Public so Bootstrap can wire it
 * directly when it prefers explicit lifecycle plumbing over the
 * self-registered handler below. Clearing the timer prevents a late
 * fire from touching a state bag for a Source the engine has already
 * recycled.
 */
export function OnPlayerDropped(Source: number): void {
  const Timer = Timers.get(Source);
  if (Timer !== undefined) {
    clearTimeout(Timer);
    Timers.delete(Source);
  }
}

/**
 * Shared registrar for /ame and /amy. The only meaningful axis is
 * whether the formatted body wears the possessive `'s` between name
 * and action; everything else - empty-body guard, state-bag write,
 * timer reset, chat ack - is identical between the two.
 */
function RegisterNametagAction(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  Name: string,
  Description: string,
  _Tag: 'Plain' | 'Possessive',
  Possessive: boolean,
): void {
  Registry.Add({
    Name,
    Description,
    Params: '<action>',
    Category: 'RP',
    RequireCharacter: true,
    BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody(Name)),
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Formatted = Possessive
        ? `* ${DisplayName}'s ${Body}`
        : `* ${DisplayName} ${Body}`;

      WriteBag(Ctx.Source, Formatted);
      ResetTimer(Ctx.Source);

      // Echo the action line back to the issuer in the same purple RP
      // tint the nametag overlay renders it in. Everyone else only sees
      // the float; without this the issuer would have no chat trace of
      // having typed it - and a "set, clears in 5s" Info ack reads as
      // noise once the overlay is doing the announcement work.
      //
      // Lead with a `> ` marker (same purple tint) so the issuer can
      // tell their /ame /amy echo apart from their own /me /my at a
      // glance: /ame and /amy show as `> * Name action`, while /me and
      // /my stay at `* Name action`. The marker is issuer-only; the
      // float above the head is unprefixed.
      const ChatLine = Possessive
        ? `!{${ChatColor.RP}}> * ${DisplayName}'s ${Body}!{${ChatColor.White}}`
        : `!{${ChatColor.RP}}> * ${DisplayName} ${Body}!{${ChatColor.White}}`;

      return {
        Outcome: 'Ok',
        Reply: ChatLine,
      };
    },
  });
}

/**
 * BeforeRun guard: short-circuit empty bodies with a Usage hint so the
 * Run handler can assume a non-empty action. Mirrors the SpeechCommands
 * / RoleplayActionCommands shared helper.
 */
function AssertNonEmptyBody(Name: string): CommandBeforeRun {
  return (Ctx) => {
    if (Ctx.Args.join(' ').trim().length === 0) {
      return { Ok: false, Reason: `Usage: /${Name} <action>` };
    }
    return { Ok: true };
  };
}

/**
 * Replicated state-bag write under `Roleplay:NametagAction`. Wrapped
 * so a native exception (Source already gone, OneSync hiccup) is logged
 * rather than thrown into the command dispatcher.
 */
function WriteBag(Source: number, Value: string | null): void {
  try {
    Player(Source).state.set(StateKey, Value, true);
  } catch (Err: unknown) {
    Log.Warn(`State bag write failed - source=${Source}`, { Err: String(Err) });
  }
}

/**
 * Replace any existing clear-timer for this Source with a fresh 5 s
 * countdown. Back-to-back /ame /amy calls extend the window rather than
 * letting the first timer prematurely null the second action.
 */
function ResetTimer(Source: number): void {
  const Existing = Timers.get(Source);
  if (Existing !== undefined) clearTimeout(Existing);

  const Timer = setTimeout(() => {
    Timers.delete(Source);
    WriteBag(Source, null);
  }, ClearAfterMs);

  Timers.set(Source, Timer);
}

/**
 * One-shot init: register a playerDropped handler that drains the
 * per-Source timer so a disconnect mid-window doesn't fire a late
 * state-bag write against a recycled netId. Guarded so repeat Register
 * calls (hot reload, test setup) don't stack handlers.
 */
function EnsureHandlers(): void {
  if (HandlersRegistered) return;
  on('playerDropped', (): void => {
    OnPlayerDropped(source);
  });
  HandlersRegistered = true;
  Log.Debug('Handlers registered (playerDropped)');
}
