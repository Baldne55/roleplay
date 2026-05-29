import type { CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PlayerSessionService } from '@/Services/PlayerSessionService.js';

/**
 * Session-lifecycle commands - the chat surface for leaving the world
 * without disconnecting.
 *
 *   /changecharacter - back to /Character/Select, account session intact.
 *   /logout          - back to /Auth, account session released so the
 *                      next Enter Server click re-claims cleanly.
 *
 * Both require an active character (the registry's RequireCharacter
 * gate). Aliases mirror the variants players will reach for instinctively
 * from other RP servers.
 */
export function Register(Registry: CommandRegistry, Session: PlayerSessionService): void {
  Registry.Add({
    Name: 'changecharacter',
    Aliases: ['changechar', 'switchcharacter', 'switchchar'],
    Description: 'Return to character selection without disconnecting.',
    Category: 'Utility',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      Session.ReturnToSelect(Ctx.Source);
      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'logout',
    Aliases: ['signout'],
    Description: 'Sign out and return to the entry screen.',
    Category: 'Utility',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      Session.ReturnToAuth(Ctx.Source);
      return { Outcome: 'Ok' };
    },
  });
}
