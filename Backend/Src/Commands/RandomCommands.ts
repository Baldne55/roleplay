import { ChatFormatter, ChatRanges } from '@Shared/Chat/Index.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/**
 * Random-outcome roleplay helpers - /dice (alias /rolldice) and /coin
 * (alias /flipcoin). Both render as /me-style RP actions in purple and
 * broadcast at the standard 10 m Say range so only nearby characters
 * see the result. Names resolve through the mask-aware DisplayName
 * helper, so masked rollers stay anonymous behind their Stranger ID.
 *
 * Math.random is deliberate here and is NOT the standard elsewhere: these
 * outcomes are cosmetic RP flavour, so bias or predictability costs
 * nothing. Anything an attacker could profit from guessing - item
 * serials, forensic IDs, phone numbers - uses `randomInt` from node's
 * crypto instead. Do not copy this call into those paths.
 *
 * Neither command registers a cooldown; spam control is the chat rate
 * limiter's job, which sees these the same as any other chat line.
 */
export function Register(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
): void {
  Registry.Add({
    Name: 'dice',
    Aliases: ['rolldice'],
    Description: 'Roll a six-sided die for nearby players.',
    Category: 'Chat',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Roll = Math.floor(Math.random() * 6) + 1;
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Action = `rolls a six-sided die and gets ${Roll}.`;
      const Line = ChatFormatter.MeAction(DisplayName, Action);
      Broadcaster.BroadcastInRange(Ctx.Source, Line, ChatRanges.Say);
      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'coin',
    Aliases: ['flipcoin'],
    Description: 'Flip a coin for nearby players.',
    Category: 'Chat',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Face = Math.random() < 0.5 ? 'Heads' : 'Tails';
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Action = `flips a coin and it lands on ${Face}.`;
      const Line = ChatFormatter.MeAction(DisplayName, Action);
      Broadcaster.BroadcastInRange(Ctx.Source, Line, ChatRanges.Say);
      return { Outcome: 'Ok' };
    },
  });
}
