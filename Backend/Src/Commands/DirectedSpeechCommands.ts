import {
  ChatColor,
  ChatFormatter,
  ChatRanges,
  ChatVerbs,
  type ChatType,
} from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';

/**
 * Directed-speech commands - /to, /shoutto, /wto. The sender addresses a
 * specific nearby target; everyone in the channel's normal range hears the
 * line, and the target additionally receives a marker-prefixed copy so the
 * cue lands at the bottom of their scrollback. The yellow `-> ` prefix is a
 * forward-prep placeholder for the directed-speech indicator UI; once that
 * ships, the marker branch collapses to a single proximity broadcast plus a
 * dedicated NUI marker event.
 *
 * Self-target is rejected by default. The single exception is the highest
 * staff rank (Founder) on admin duty - they can /to themselves to probe
 * the directed-speech format and pink-marker target view live without
 * needing a second client. Mirrors the /pm self-PM exception.
 */
export function Register(
  Registry: CommandRegistry,
  Chat: ChatService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Accounts: AccountRepository,
): void {
  RegisterDirected(
    Registry,
    Chat,
    State,
    Broadcaster,
    Accounts,
    'to',
    ['sayto'],
    'Say something directed at a nearby player (10 m).',
    'Say',
  );
  RegisterDirected(
    Registry,
    Chat,
    State,
    Broadcaster,
    Accounts,
    'shoutto',
    ['sto'],
    'Shout directed at a nearby player (25 m).',
    'Shout',
  );
  RegisterDirected(
    Registry,
    Chat,
    State,
    Broadcaster,
    Accounts,
    'wto',
    [],
    'Whisper directly to a nearby player (3 m).',
    'Whisper',
  );
}

/**
 * Register one directed-speech variant. The handler resolves both names
 * through DisplayName so masked characters stay anonymous, broadcasts the
 * `(to <Target>)` bystander line at the channel range, then sends the same
 * line prefixed with a yellow arrow marker straight to the target. The
 * target receives both copies; the marker line arrives second and so lands
 * at the bottom of their scrollback as the visible cue. When the
 * directed-speech indicator UI ships, the marker branch can be replaced
 * with a single proximity broadcast plus a separate NUI marker event.
 */
function RegisterDirected(
  Registry: CommandRegistry,
  Chat: ChatService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Accounts: AccountRepository,
  Name: string,
  Aliases: readonly string[],
  Description: string,
  Type: ChatType,
): void {
  Registry.Add({
    Name,
    Aliases,
    Description,
    Params: '<player_id> <message>',
    Category: 'Chat',
    RequireCharacter: true,
    BeforeRun: AssertDirectedArgs(Name),
    Run: async (Ctx): Promise<CommandResult> => {
      const Target = Number(Ctx.Args[0]);
      if (!Number.isInteger(Target)) {
        return { Outcome: 'BadArgs', Reason: `Usage: /${Name} <player_id> <message>` };
      }
      if (Target === Ctx.Source) {
        // Founder + admin duty bypass — lets devs probe the directed-speech
        // format and the pink-marker target view in isolation without
        // needing a second client. Mirrors the /pm self-PM exception.
        if (
          Ctx.PlayerState.AccountID === null ||
          !Ctx.PlayerState.AdminDuty
        ) {
          return { Outcome: 'BadArgs', Reason: 'You cannot direct that at yourself.' };
        }
        const Account = await Accounts.FindByID(Ctx.PlayerState.AccountID);
        if (Account === null || Account.StaffLevel !== 'Founder') {
          return { Outcome: 'BadArgs', Reason: 'You cannot direct that at yourself.' };
        }
        // Fall through — both bystander and target lines land on the same
        // Source. Skip the ExcludeReceiver argument on BroadcastInRange so
        // the sender sees the bystander line too, AND we still Chat.SendTo
        // the marker line. Both views render in the probing player's chat.
      } else if (State.Get(Target)?.Phase !== 'Spawned') {
        return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
      }

      const Body = Ctx.Args.slice(1).join(' ').trim();
      if (Body.length === 0) {
        return { Outcome: 'BadArgs', Reason: `Usage: /${Name} <player_id> <message>` };
      }

      const SenderName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const TargetName = Broadcaster.DisplayName(Target) ?? 'someone';
      const Verb = ChatVerbs[Type];

      // Bystanders see the third-person form with the target named.
      const GeneralLine = ChatFormatter.ApplyChannelTint(
        `${SenderName} ${Verb} to ${TargetName}: ${Body}`,
        Type,
      );
      // The target sees "to you" plus the pink `-> ` marker prefix. When
      // the Founder self-bypass fires, the probing player sees "to you"
      // on their own marker line — exactly what they want to verify.
      const TargetBody = ChatFormatter.ApplyChannelTint(
        `${SenderName} ${Verb} to you: ${Body}`,
        Type,
      );
      const MarkedLine = `!{${ChatColor.Directed}}-> !{${ChatColor.White}}${TargetBody}`;

      if (Target === Ctx.Source) {
        // Don't exclude self — we want both lines rendered for format probe.
        Broadcaster.BroadcastInRange(Ctx.Source, GeneralLine, ChatRanges[Type]);
      } else {
        Broadcaster.BroadcastInRange(Ctx.Source, GeneralLine, ChatRanges[Type], Target);
      }
      Chat.SendTo(Target, MarkedLine);

      return { Outcome: 'Ok' };
    },
  });
}

/**
 * BeforeRun guard shared by every directed-speech variant: require at
 * least a target id and one body token. Deeper validation (integer parse,
 * self-target, target phase, empty body after slice) runs inside Run so
 * the rejection messages can be specific.
 */
function AssertDirectedArgs(Name: string): CommandBeforeRun {
  return (Ctx) => {
    if (Ctx.Args.length < 2) {
      return { Ok: false, Reason: `Usage: /${Name} <player_id> <message>` };
    }
    return { Ok: true };
  };
}
