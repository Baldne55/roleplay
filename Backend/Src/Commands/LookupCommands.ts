import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/**
 * Lookup commands - the utility surface for resolving who is who.
 *
 * /id accepts either a numeric Source or a display-name fragment. The
 * numeric path falls through to a substring search when the Source isn't
 * spawned, so `/id 4421` against a masked player still matches their
 * `Mask 4421` display name.
 */
export function Register(
  Registry: CommandRegistry,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
): void {
  Registry.Add({
    Name: 'id',
    Description: 'Look up a player by name or Source ID.',
    Params: '<name or id>',
    Category: 'Utility',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Raw = Ctx.Args[0];
      if (Raw === undefined || Raw.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /id <name or id>' };
      }

      const Parsed = Number(Raw);
      if (Number.isFinite(Parsed) && Number.isInteger(Parsed)) {
        const Target = Parsed;
        if (State.Get(Target)?.Phase === 'Spawned') {
          const Name = Broadcaster.DisplayName(Target);
          if (Name !== null) {
            return {
              Outcome: 'Ok',
              Reply: ChatFormatter.OOC(
                ChatFormatter.Label('Player', `${Name} (Source #${Target})`),
              ),
            };
          }
        }
        // Fall through to substring search with the raw token so a numeric
        // input like `4421` still matches a masked player's `Mask 4421`.
      }

      const Query = Raw.toLowerCase();
      const Hits: { Source: number; Name: string }[] = [];
      for (const Src of State.GetSpawnedSources()) {
        const Name = Broadcaster.DisplayName(Src);
        if (Name === null) continue;
        if (!Name.toLowerCase().includes(Query)) continue;
        Hits.push({ Source: Src, Name });
      }

      if (Hits.length === 0) {
        return {
          Outcome: 'Ok',
          Reply: ChatFormatter.Error(`No matches for "${Raw}".`),
        };
      }

      Hits.sort((A, B) => A.Source - B.Source);
      const Overflow = Hits.length > 10;
      const Shown = Overflow ? Hits.slice(0, 10) : Hits;

      const Lines: string[] = [ChatFormatter.Header('Lookup', ChatColor.Primary)];
      for (const Hit of Shown) {
        Lines.push(
          ChatFormatter.OOC(
            ChatFormatter.Label('Player', `${Hit.Name} (Source #${Hit.Source})`),
          ),
        );
      }
      if (Overflow) {
        Lines.push(ChatFormatter.OOC('(More than 10 results - refine your query.)'));
      }
      Lines.push(ChatFormatter.Footer(ChatColor.Primary));

      return { Outcome: 'Ok', Reply: Lines.join('\n') };
    },
  });
}
