import { ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/**
 * Global OOC channel - /o - the server-wide out-of-character broadcast.
 * Gated on Founder rank as a placeholder until a broader staff duty /
 * global-channel system ships; the registry enforces both the staff level
 * and the AdminDuty toggle automatically because RequiredStaffLevel is set.
 * Visual formatting reuses the LocalOoc grey wrap for now - future work
 * will give the global channel its own colour and bracket convention so
 * players can tell server-wide OOC apart from the 15 m local bracket.
 */
export function Register(
  Registry: CommandRegistry,
  Chat: ChatService,
  Broadcaster: ProximityBroadcaster,
): void {
  Registry.Add({
    Name: 'o',
    Aliases: ['globalooc'],
    Description: 'Speak out-of-character to all spawned players globally.',
    Params: '<message>',
    Category: 'Chat',
    RequireCharacter: true,
    RequiredStaffLevel: 'Founder',
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      if (Body.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /o <message>' };
      }
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Line = ChatFormatter.LocalOoc(DisplayName, Body);
      Chat.BroadcastToSpawned(Line);
      return { Outcome: 'Ok' };
    },
  });
}
