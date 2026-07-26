import { ChatFormatter, ChatRanges, type ChatType } from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { PhoneCallService } from '@/Services/PhoneCallService.js';
import { AssertHealthy, ChainBeforeRun } from '@/Commands/Shared/AssertHealthy.js';

/**
 * Proximity-chat speech commands - the IC voice surface. /say, /shout,
 * /whisper, /low map to the four volume brackets and broadcast via the
 * shared ProximityBroadcaster at their ChatRanges-defined radii. /b
 * piggybacks the same fan-out but wraps the body in the LocalOoc bracket
 * format so nearby players can break character without leaving the radio.
 */
export function Register(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  PhoneCall: PhoneCallService,
): void {
  RegisterSpeech(Registry, Broadcaster, Runtimes, PhoneCall, 'say', [], 'Speak at normal volume (10 m).', 'Say');
  RegisterSpeech(Registry, Broadcaster, Runtimes, PhoneCall, 'shout', ['s'], 'Shout a message (25 m).', 'Shout');
  RegisterSpeech(Registry, Broadcaster, Runtimes, PhoneCall, 'whisper', ['w'], 'Whisper a message (3 m).', 'Whisper');
  RegisterSpeech(Registry, Broadcaster, Runtimes, PhoneCall, 'low', ['l'], 'Speak quietly (5 m).', 'Low');

  // /b and /blow are OOC channels; deliberately NOT gated by AssertHealthy
  // so an incapacitated player can still break character and call for help.
  RegisterLocalOoc(Registry, Broadcaster, 'b',    ['ooc'], 'Speak out-of-character to nearby players (15 m).', ChatRanges.Ooc);
  RegisterLocalOoc(Registry, Broadcaster, 'blow', [],      'Speak out-of-character in low voice (5 m).',       ChatRanges.Low);
}

/**
 * /b and /blow share a body - same formatter, only the broadcast range
 * differs. /b carries the standard 15 m OOC reach; /blow tightens to
 * the 5 m Low bracket for intimate scenes where an OOC aside should
 * not leak to onlookers.
 */
function RegisterLocalOoc(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Name: string,
  Aliases: readonly string[],
  Description: string,
  Range: number,
): void {
  Registry.Add({
    Name,
    Aliases,
    Description,
    Params: '<message>',
    Category: 'Chat',
    RequireCharacter: true,
    BeforeRun: AssertNonEmptyBody(Name),
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Line = ChatFormatter.LocalOoc(DisplayName, Body);
      Broadcaster.BroadcastInRange(Ctx.Source, Line, Range);
      return { Outcome: 'Ok' };
    },
  });
}

/**
 * Register one of the four speech variants. Shared so /say, /shout,
 * /whisper, /low stay byte-identical apart from their channel constants.
 */
function RegisterSpeech(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  PhoneCall: PhoneCallService,
  Name: string,
  Aliases: readonly string[],
  Description: string,
  Type: ChatType,
): void {
  Registry.Add({
    Name,
    Aliases,
    Description,
    Params: '<message>',
    Category: 'Chat',
    RequireCharacter: true,
    BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody(Name)),
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      Broadcaster.BroadcastSpeech(Ctx.Source, Body, Type);
      // In-call relay: only ordinary /say carries down a live phone line
      // (user decision). The peer copy is attributed to number/contact,
      // never the legal name; no-op when the speaker is not on a call.
      if (Type === 'Say') PhoneCall.RelayIfOnCall(Ctx.Source, Body);
      return { Outcome: 'Ok' };
    },
  });
}

/**
 * BeforeRun guard shared by every speech variant: reject empty bodies
 * with a Usage hint so Run handlers can assume Args.join(' ').trim() is
 * non-empty.
 */
function AssertNonEmptyBody(Name: string): CommandBeforeRun {
  return (Ctx) => {
    if (Ctx.Args.join(' ').trim().length === 0) {
      return { Ok: false, Reason: `Usage: /${Name} <message>` };
    }
    return { Ok: true };
  };
}
