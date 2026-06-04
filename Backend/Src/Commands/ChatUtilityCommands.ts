import { ChatFormatter } from '@Shared/Chat/Index.js';
import {
  DefaultAccountSettings,
  type AccountSettings,
} from '@Shared/Constants/AccountSettings.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { AccountSettingsService } from '@/Services/AccountSettingsService.js';
import { Logger } from '@/Util/Logger.js';

declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;

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

type ToggleSettingKey =
  | 'ChatTimestamp'
  | 'ChatVisible'
  | 'ChatCharacterCounter'
  | 'ChatBlindfold'
  | 'NametagSelfVisible'
  | 'NametagIDVisible';

/**
 * Sub-command table for /toggle. Canonical names and aliases both index
 * into the same entry so the runtime lookup is a single bracket access.
 * Every entry now carries a real SettingKey - the nametag pair got
 * persistent backing when the overlay shipped.
 */
interface ToggleEntry {
  Canonical: string;
  BagKey: string;
  Ack: string;
  SettingKey: ToggleSettingKey;
}

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

const ToggleAliases: Record<string, string> = {
  counter: 'charactercounter',
  selftag: 'selfnametag',
  tagid: 'nametagid',
};

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

const CanonicalToggleNames: readonly string[] = ToggleEntries.map((Entry) => Entry.Canonical);
