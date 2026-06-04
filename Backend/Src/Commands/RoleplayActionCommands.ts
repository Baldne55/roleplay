import { ChatFormatter, ChatRanges, type ChatType } from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/**
 * Roleplay action commands - the /me /do /my surface, each in three range
 * variants that share the same Say / Low / Shout brackets the speech
 * channels use.
 *
 *   /me   /melow   /melong  - actor-centred action ("* Name <action>").
 *   /do   /dolow   /dolong  - scene / environment description ("* <desc> (( Name )) *").
 *   /my   /mylow   /mylong  - possessive detail about the actor ("* Name's <desc>").
 *
 * Low variants narrow to 5 m, long variants extend to 25 m; the unmarked
 * base sits at the default 10 m Say range. All nine require an active
 * character and route through ProximityBroadcaster for mask-aware naming.
 */

type FormatterTag = 'Me' | 'Do' | 'My';

export function Register(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
): void {
  RegisterAction(Registry, Broadcaster, 'me', 'Perform a roleplay action (10 m).', '<action>', 'Say', 'Me');
  RegisterAction(Registry, Broadcaster, 'melow', 'Perform a roleplay action in low voice (5 m).', '<action>', 'Low', 'Me');
  RegisterAction(Registry, Broadcaster, 'melong', 'Perform a roleplay action with extended range (25 m).', '<action>', 'Shout', 'Me');

  RegisterAction(Registry, Broadcaster, 'do', 'Describe an environment or scene action (10 m).', '<description>', 'Say', 'Do');
  RegisterAction(Registry, Broadcaster, 'dolow', 'Describe an environment or scene action in low voice (5 m).', '<description>', 'Low', 'Do');
  RegisterAction(Registry, Broadcaster, 'dolong', 'Describe an environment or scene action with extended range (25 m).', '<description>', 'Shout', 'Do');

  RegisterAction(Registry, Broadcaster, 'my', 'Describe something about your character (10 m).', '<description>', 'Say', 'My');
  RegisterAction(Registry, Broadcaster, 'mylow', 'Describe something about your character in low voice (5 m).', '<description>', 'Low', 'My');
  RegisterAction(Registry, Broadcaster, 'mylong', 'Describe something about your character with extended range (25 m).', '<description>', 'Shout', 'My');
}

/**
 * One-line registration helper. Each /me /do /my variant collapses to a
 * single call; the helper wires the formatter dispatch, the empty-body
 * guard, and the proximity fan-out so the nine entries read as a table.
 */
function RegisterAction(
  Registry: CommandRegistry,
  Broadcaster: ProximityBroadcaster,
  Name: string,
  Description: string,
  Params: string,
  RangeType: ChatType,
  Tag: FormatterTag,
): void {
  Registry.Add({
    Name,
    Description,
    Params,
    Category: 'RP',
    RequireCharacter: true,
    BeforeRun: AssertNonEmptyBody(Name, Params),
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Line = FormatLine(Tag, DisplayName, Body);
      Broadcaster.BroadcastInRange(Ctx.Source, Line, ChatRanges[RangeType]);
      return { Outcome: 'Ok' };
    },
  });
}

/**
 * Dispatch the resolved name and body through the right ChatFormatter
 * call. /do's signature flips the argument order (Description first,
 * Name second); the tag keeps that quirk local to this module.
 */
function FormatLine(Tag: FormatterTag, Name: string, Body: string): string {
  switch (Tag) {
    case 'Me':
      return ChatFormatter.MeAction(Name, Body);
    case 'Do':
      return ChatFormatter.DoAction(Body, Name);
    case 'My':
      return ChatFormatter.MyAction(Name, Body);
  }
}

/**
 * BeforeRun factory: short-circuit with a usage hint when the player
 * submits the command with no action body. Params is folded into the
 * Reason so the message reads as a real usage line rather than a generic
 * "argument required" placeholder.
 */
function AssertNonEmptyBody(Name: string, Params: string): CommandBeforeRun {
  return (Context) => {
    if (Context.Args.join(' ').trim().length === 0) {
      return { Ok: false, Reason: `Usage: /${Name} ${Params}` };
    }
    return { Ok: true };
  };
}
