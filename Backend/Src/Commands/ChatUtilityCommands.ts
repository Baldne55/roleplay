import { ChatFormatter } from '@Shared/Chat/Index.js';
import {
  DefaultAccountSettings,
  type AccountSettings,
} from '@Shared/Constants/AccountSettings.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { AccountSettingsService } from '@/Services/AccountSettingsService.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Chat / nametag UI utility commands. Every entry that mutates a
 * preference does so through AccountSettingsService so the value
 * persists across reconnect.
 *
 *   /clearchat            - wipes the SPA scrollback via Chat.Clear.
 *   /toggle <setting>     - dispatcher over six chat / nametag knobs.
 *   /fontsize / /pagesize - value-carrying chat preference setters.
 *
 * Flow on /toggle <name>:
 *   1. Load AccountSettings (defaults-merged) for the player's account.
 *   2. Flip the boolean for the chosen key.
 *   3. UpdateMerge writes the new partial back to the JSON column.
 *   4. Emit ChatSettingChanged with the RESOLVED new value so the SPA
 *      applies it directly rather than flipping its own copy.
 *   5. Also write a replicated state-bag entry for any cross-resource
 *      consumer (nametag overlay, future scoreboard, etc.).
 *
 * /fontsize and /pagesize follow the same shape but without a flip -
 * the new numeric value comes from the player's argument.
 */
const Log = Logger.New('ChatUtility');

/**
 * Wire the chat preference commands described in the header above.
 *
 * Each setter writes three places: the account settings JSON (durable),
 * a replicated state bag (for cross-resource consumers), and a
 * ChatSettingChanged event (so an open overlay re-renders at once).
 */
export function Register(
  Registry: CommandRegistry,
  Chat: ChatService,
  Settings: AccountSettingsService,
): void {
  Registry.Add({
    Name: 'clearchat',
    Description: 'Wipe your local chat scrollback.',
    Category: 'Utility',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      Chat.Clear(Ctx.Source);
      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'toggle',
    Description: 'Toggle a chat / nametag UI setting.',
    Params: '<setting>',
    Category: 'Utility',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      const Raw = Ctx.Args[0];
      if (Raw === undefined) {
        return {
          Outcome: 'BadArgs',
          Reason: `Usage: /toggle <setting>. Available: ${CanonicalToggleNames.join(', ')}.`,
        };
      }
      const Input = Raw.toLowerCase();
      const Entry = ToggleLookup[Input];
      if (Entry === undefined) {
        return {
          Outcome: 'BadArgs',
          Reason: `Unknown toggle: ${Input}. Available: ${CanonicalToggleNames.join(', ')}.`,
        };
      }
      if (Ctx.PlayerState.AccountID === null) {
        return { Outcome: 'PermissionDenied' };
      }

      // Every /toggle entry now persists - the nametag pair got real
      // backing fields when the overlay shipped, so the legacy
      // timestamp-only fallback is gone.
      const Current = await Settings.Get(Ctx.PlayerState.AccountID);
      const PrevValue = ResolveBool(Current, Entry.SettingKey);
      const NewValue = !PrevValue;
      try {
        await Settings.UpdateMerge(Ctx.PlayerState.AccountID, {
          [Entry.SettingKey]: NewValue,
        });
      } catch (Err: unknown) {
        Log.Warn(`Failed to persist toggle ${Input} for account=${Ctx.PlayerState.AccountID}`, {
          Err: String(Err),
        });
      }

      // Bag carries the resolved value (not a timestamp) so the nametag
      // overlay can read LocalPlayer.state.<key> directly without a
      // round-trip through the SPA's settings store.
      Player(Ctx.Source).state.set(Entry.BagKey, NewValue, true);
      EmitSettingChanged(Ctx.Source, Entry.Canonical, NewValue);
      return { Outcome: 'Ok', Reply: ChatFormatter.Info(Entry.Ack) };
    },
  });

  Registry.Add({
    Name: 'fontsize',
    Description: 'Set chat font size (default: 0.65).',
    Params: '<0.5-1.5>',
    Category: 'Utility',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /fontsize <0.5-1.5>' };
      }
      const Value = Number(Ctx.Args[0]);
      if (!Number.isFinite(Value) || Value < 0.5 || Value > 1.5) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /fontsize <0.5-1.5>' };
      }
      if (Ctx.PlayerState.AccountID === null) {
        return { Outcome: 'PermissionDenied' };
      }
      try {
        await Settings.UpdateMerge(Ctx.PlayerState.AccountID, { ChatFontSize: Value });
      } catch (Err: unknown) {
        Log.Warn(`Failed to persist /fontsize for account=${Ctx.PlayerState.AccountID}`, {
          Err: String(Err),
        });
      }
      Player(Ctx.Source).state.set('Roleplay:Chat:FontSize', Value, true);
      EmitSettingChanged(Ctx.Source, 'fontsize', Value);
      return { Outcome: 'Ok', Reply: ChatFormatter.Info(`Chat font size set to ${Value}.`) };
    },
  });

  Registry.Add({
    Name: 'pagesize',
    Description: 'Set chat page size (default: 20).',
    Params: '<5-40>',
    Category: 'Utility',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /pagesize <5-40>' };
      }
      const Value = Number(Ctx.Args[0]);
      if (!Number.isInteger(Value) || Value < 5 || Value > 40) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /pagesize <5-40>' };
      }
      if (Ctx.PlayerState.AccountID === null) {
        return { Outcome: 'PermissionDenied' };
      }
      try {
        await Settings.UpdateMerge(Ctx.PlayerState.AccountID, { ChatPageSize: Value });
      } catch (Err: unknown) {
        Log.Warn(`Failed to persist /pagesize for account=${Ctx.PlayerState.AccountID}`, {
          Err: String(Err),
        });
      }
      Player(Ctx.Source).state.set('Roleplay:Chat:PageSize', Value, true);
      EmitSettingChanged(Ctx.Source, 'pagesize', Value);
      return { Outcome: 'Ok', Reply: ChatFormatter.Info(`Chat page size set to ${Value}.`) };
    },
  });
}

/**
 * Notify the client that one chat setting changed.
 *
 * Sent alongside the state-bag write, not instead of it: the bag is the
 * durable value the UI reads on (re)load, while this event is the nudge
 * that lets an already-open overlay re-render immediately rather than
 * waiting to notice the bag change.
 */
function EmitSettingChanged(Source: number, Key: string, Value: boolean | number): void {
  const Payload: NetEventPayloads[typeof NetEvents.ChatSettingChanged] = { Key, Value };
  emitNet(NetEvents.ChatSettingChanged, Source, Payload);
}

/**
 * Read a boolean setting honouring the defaults if the stored value is
 * absent. Inferred for the keys the toggle dispatcher handles - the
 * runtime narrowing keeps the lookup honest if a new chat boolean lands
 * later.
 */
function ResolveBool(
  Snapshot: AccountSettings,
  Key: ToggleSettingKey,
): boolean {
  const Stored = Snapshot[Key];
  if (typeof Stored === 'boolean') return Stored;
  return DefaultAccountSettings[Key];
}

/**
 * The AccountSettings keys /toggle is allowed to flip. Deliberately a
 * closed union rather than `keyof AccountSettings`: it keeps the numeric
 * settings (ChatFontSize, ChatPageSize) unreachable from a boolean flip,
 * so a new entry in ToggleEntries pointing at a non-boolean field fails
 * to compile instead of writing `!42` into the JSON column.
 */
type ToggleSettingKey =
  | 'ChatTimestamp'
  | 'ChatVisible'
  | 'ChatCharacterCounter'
  | 'ChatBlindfold'
  | 'NametagSelfVisible'
  | 'NametagIDVisible';

/**
 * One /toggle sub-command. Carries the three write targets a flip needs:
 * SettingKey (durable JSON column), BagKey (replicated state bag other
 * resources read), and Canonical (the name echoed to the SPA in the
 * ChatSettingChanged event). Ack is the confirmation line.
 *
 * Every entry has a real SettingKey - the nametag pair got persistent
 * backing when the overlay shipped, so there is no longer a
 * bag-only/ephemeral variant to account for.
 */
interface ToggleEntry {
  Canonical: string;
  BagKey: string;
  Ack: string;
  SettingKey: ToggleSettingKey;
}

/**
 * The registered toggles, in the order /toggle lists them when the
 * player supplies no argument or an unknown one.
 */
const ToggleEntries: readonly ToggleEntry[] = [
  {
    Canonical: 'timestamp',
    BagKey: 'Roleplay:Chat:Timestamp',
    Ack: 'Chat timestamps toggled.',
    SettingKey: 'ChatTimestamp',
  },
  {
    Canonical: 'chat',
    BagKey: 'Roleplay:Chat:Visible',
    Ack: 'Chat overlay visibility toggled.',
    SettingKey: 'ChatVisible',
  },
  {
    Canonical: 'charactercounter',
    BagKey: 'Roleplay:Chat:CharacterCounter',
    Ack: 'Character counter toggled.',
    SettingKey: 'ChatCharacterCounter',
  },
  {
    Canonical: 'selfnametag',
    BagKey: NametagBagKeys.SelfVisible,
    Ack: 'Own nametag visibility toggled.',
    SettingKey: 'NametagSelfVisible',
  },
  {
    Canonical: 'nametagid',
    BagKey: NametagBagKeys.IDVisible,
    Ack: 'Player ID in nametags toggled.',
    SettingKey: 'NametagIDVisible',
  },
  {
    Canonical: 'blindfold',
    BagKey: 'Roleplay:Chat:Blindfold',
    Ack: 'Chat background blindfold toggled.',
    SettingKey: 'ChatBlindfold',
  },
];

/**
 * Shorthand players type instead of the canonical name. Alias -> canonical;
 * resolved into ToggleLookup below so both spellings hit the same entry.
 * Aliases are intentionally absent from the "Available:" hint - listing
 * them doubles the line length for no added discoverability.
 */
const ToggleAliases: Record<string, string> = {
  counter: 'charactercounter',
  selftag: 'selfnametag',
  tagid: 'nametagid',
};

/**
 * Flattened canonical-and-alias index, built once at module load so the
 * runtime lookup in /toggle is a single bracket access rather than a
 * scan plus an alias fallback.
 *
 * An alias pointing at a canonical name that does not exist is dropped
 * silently - the `undefined` guard means a typo in ToggleAliases costs
 * that one alias, not a crash at import time.
 */
const ToggleLookup: Record<string, ToggleEntry> = (() => {
  const Map: Record<string, ToggleEntry> = {};
  for (const Entry of ToggleEntries) {
    Map[Entry.Canonical] = Entry;
  }
  for (const [Alias, Canonical] of Object.entries(ToggleAliases)) {
    const Entry = Map[Canonical];
    if (Entry !== undefined) Map[Alias] = Entry;
  }
  return Map;
})();

/** Canonical names only, for the usage / unknown-toggle hint lines. */
const CanonicalToggleNames: readonly string[] = ToggleEntries.map((Entry) => Entry.Canonical);
