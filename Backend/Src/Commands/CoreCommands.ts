import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandCategory, CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';

/**
 * Core / utility commands - the always-on surface that doesn't belong
 * to any feature cluster. Currently just /help, the smoke-test command
 * that proves the registry pipeline is alive.
 */
export function Register(Registry: CommandRegistry): void {
  Registry.Add({
    Name: 'help',
    Aliases: ['commands'],
    Description: 'List the commands you can use.',
    Category: 'Utility',
    Run: (): CommandResult => ({
      Outcome: 'Ok',
      Reply: BuildHelpReply(Registry),
    }),
  });
}

/**
 * Render every registered command into a category-grouped block.
 * Header / Footer match the emerald frame the welcome card and notice
 * block use; body rows wear the standard `(( ))` OOC wrap because /help
 * is server narration, not IC chat.
 */
function BuildHelpReply(Registry: CommandRegistry): string {
  const Groups = new Map<CommandCategory, string[]>();
  for (const Definition of Registry.GetAll()) {
    const Bucket = Groups.get(Definition.Category) ?? [];
    Bucket.push(`/${Definition.Name}`);
    Groups.set(Definition.Category, Bucket);
  }

  const Order: CommandCategory[] = ['Chat', 'RP', 'Comms', 'Utility', 'Admin'];
  const Lines: string[] = [ChatFormatter.Header('Help', ChatColor.Primary)];
  for (const Category of Order) {
    const Entries = Groups.get(Category);
    if (Entries === undefined || Entries.length === 0) continue;
    Lines.push(ChatFormatter.OOC(ChatFormatter.Label(Category, Entries.sort().join(', '))));
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Primary));
  return Lines.join('\n');
}
