import { ChatColor } from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { NametagActionService } from '@/Services/NametagActionService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import { AssertHealthy, ChainBeforeRun } from '@/Commands/Shared/AssertHealthy.js';

/**
 * Nametag-action commands - /ame and /amy - the floating action line
 * above a character's nametag. The bag write, clear timer, and drop
 * cleanup live in NametagActionService (shared with the item
 * interactions, which float their narrations on the same channel);
 * this module only parses, formats the possessive variant, and
 * chat-acks the issuer.
 *
 * Unlike /me and /my these carry no proximity broadcast: the float above
 * the head IS the delivery mechanism, so range is whatever the nametag
 * overlay draws at rather than a ChatRanges bracket. The only chat traffic
 * is the issuer's own echo.
 */
export function Register(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  Actions: NametagActionService,
): void {
  RegisterNametagAction(
    Registry,
    Broadcaster,
    Runtimes,
    Actions,
    'ame',
    'Set a roleplay action displayed above your nametag.',
    false,
  );

  RegisterNametagAction(
    Registry,
    Broadcaster,
    Runtimes,
    Actions,
    'amy',
    'Set a possessive roleplay action displayed above your nametag.',
    true,
  );
}

/**
 * Shared registrar for /ame and /amy. The only meaningful axis is
 * whether the formatted body wears the possessive `'s` between name
 * and action; everything else - empty-body guard, the service write,
 * chat ack - is identical between the two.
 */
function RegisterNametagAction(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  Actions: NametagActionService,
  Name: string,
  Description: string,
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

      Actions.SetFormatted(Ctx.Source, Formatted);

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
