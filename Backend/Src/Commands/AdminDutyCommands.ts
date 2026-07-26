import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import type { BleedingStatus } from '@Shared/Constants/Character.js';
import type { StaffLevel } from '@/Data/Models/Account.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { BleedingService } from '@/Services/BleedingService.js';

/**
 * Staff levels that can review the unified item-request queue
 * (mirrors the gates on /alistitemrequests + /aapproveitemrequest +
 * /adenyitemrequest). Helpers cannot - keep them out of the duty-on
 * notification.
 */
const QueueViewerStaffLevels: ReadonlySet<StaffLevel> = new Set([
  'Moderator',
  'Administrator',
  'Founder',
]);

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Admin-duty surface. /aduty is the gate that unblocks staff commands -
 * the registry's RequiredStaffLevel check also enforces AdminDuty by
 * default, so without this toggle a staff member could never reach any
 * staff command. SkipDutyCheck=true is mandatory here for that reason.
 * /admins is the public lookup any player can run; it resolves names
 * through the broadcaster's mask-aware DisplayName so masked staff do
 * not leak identity through the on-duty roster.
 * /asetbleeding is the staff override for the bleeding tier - the same
 * rank gate as /arevive, a thin pass-through to BleedingService.SetTier
 * with OOC confirmation to the issuer only (the service sends no toast
 * on the admin path).
 */
export function Register(
  Registry: CommandRegistry,
  State: PlayerStateService,
  Accounts: AccountRepository,
  Broadcaster: ProximityBroadcaster,
  Inventory: InventoryService,
  Chat: ChatService,
  Bleeding: BleedingService,
): void {
  Registry.Add({
    Name: 'aduty',
    Description: 'Toggle your admin-on-duty state.',
    Category: 'Admin',
    RequireCharacter: true,
    RequiredStaffLevel: 'Helper',
    SkipDutyCheck: true,
    Run: async (Ctx): Promise<CommandResult> => {
      const NowOn = !Ctx.PlayerState.AdminDuty;
      State.SetAdminDuty(Ctx.Source, NowOn);

      // Nametag overlay reads three keys: a boolean gate, the rank
      // label rendered as `[Label]` prefix, and the Discord display
      // name that supersedes the character name while on duty (lc-rp
      // parity - the IC mask falls away when a staff member badges up).
      // Off-duty: zero everything so the overlay reverts cleanly.
      let LevelOnDuty: StaffLevel | null = null;
      if (NowOn && Ctx.PlayerState.AccountID !== null) {
        const Account = await Accounts.FindByID(Ctx.PlayerState.AccountID);
        const Label = Account !== null ? Account.StaffLevel : 'Helper';
        const Name =
          Account !== null
            ? Account.DiscordDisplayName ?? Account.DiscordUsername ?? Label
            : Label;
        WriteBag(Ctx.Source, NametagBagKeys.AdminDuty, true);
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyLabel, Label);
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyName, Name);
        LevelOnDuty = Account?.StaffLevel ?? null;
      } else {
        WriteBag(Ctx.Source, NametagBagKeys.AdminDuty, false);
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyLabel, '');
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyName, '');
      }

      if (NowOn && LevelOnDuty !== null && QueueViewerStaffLevels.has(LevelOnDuty)) {
        // Best-effort: any DB hiccup must not block the duty toggle.
        try {
          const Count = await Inventory.CountPendingNameRequests();
          if (Count > 0) {
            Chat.SendTo(
              Ctx.Source,
              ChatFormatter.Info(
                `${Count} item request${Count === 1 ? '' : 's'} pending review. ` +
                  'Use /aitem requests to view, /aitem approve <id> or /aitem deny <id> [reason] to action.',
              ),
            );
          }
        } catch {
          // Swallow - duty toggle is the primary action.
        }
      }

      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(
          NowOn ? 'You are now on admin duty.' : 'You are no longer on admin duty.',
        ),
      };
    },
  });

  Registry.Add({
    Name: 'admins',
    Description: 'List administrators currently on duty.',
    Category: 'Utility',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      const Entries: { DisplayName: string; StaffLevel: string }[] = [];
      for (const Source of State.GetSpawnedSources()) {
        const PlayerState = State.Get(Source);
        if (PlayerState === null) continue;
        if (!PlayerState.AdminDuty) continue;
        if (PlayerState.AccountID === null) continue;
        const Account = await Accounts.FindByID(PlayerState.AccountID);
        if (Account === null) continue;
        if (Account.StaffLevel === 'None') continue;
        const DisplayName = Broadcaster.DisplayName(Source);
        if (DisplayName === null) continue;
        Entries.push({ DisplayName, StaffLevel: Account.StaffLevel });
      }

      if (Entries.length === 0) {
        return {
          Outcome: 'Ok',
          Reply: ChatFormatter.Info('No administrators are currently on duty.'),
        };
      }

      const Lines: string[] = [ChatFormatter.Header('Administrators On Duty', ChatColor.Primary)];
      for (const Entry of Entries) {
        Lines.push(
          ChatFormatter.OOC(ChatFormatter.Label('Staff', `${Entry.DisplayName} (${Entry.StaffLevel})`)),
        );
      }
      Lines.push(ChatFormatter.Footer(ChatColor.Primary));

      void Ctx;
      return { Outcome: 'Ok', Reply: Lines.join('\n') };
    },
  });

  Registry.Add({
    Name: 'asetbleeding',
    Description: 'Admin: set the bleeding tier of a player.',
    Params: '<player_id> <none|light|medium|heavy>',
    Category: 'Admin',
    RequireCharacter: true,
    RequiredStaffLevel: 'Administrator',
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length < 2) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Usage: /asetbleeding <player_id> <none|light|medium|heavy>',
        };
      }
      const Target = Number(Ctx.Args[0]);
      if (!Number.isFinite(Target) || !Number.isInteger(Target)) {
        return { Outcome: 'BadArgs', Reason: 'Player ID must be a number.' };
      }
      if (State.Get(Target)?.Phase !== 'Spawned') {
        return {
          Outcome: 'BadArgs',
          Reason: `Player ${Target} is not in the world.`,
        };
      }
      const Tier = ParseBleedingTier(Ctx.Args[1] ?? '');
      if (Tier === null) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Tier must be one of: none, light, medium, heavy.',
        };
      }

      const TargetName = Broadcaster.DisplayName(Target) ?? `player ${Target}`;
      const Ok = await Bleeding.SetTier(Target, Tier);
      if (!Ok) {
        return {
          Outcome: 'BadArgs',
          Reason: `Could not set the bleeding tier of ${TargetName}.`,
        };
      }
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`You set the bleeding tier of ${TargetName} to ${Tier}.`),
      };
    },
  });
}

/**
 * Map the user-typed tier argument onto a canonical BleedingStatus.
 * Accepts the four enum values case-insensitively plus the short forms
 * none / light / medium / heavy; anything else returns null so the
 * command can render the usage line.
 */
function ParseBleedingTier(Raw: string): BleedingStatus | null {
  switch (Raw.toLowerCase()) {
    case 'none':
    case 'notbleeding':
      return 'NotBleeding';
    case 'light':
    case 'lightbleeding':
      return 'LightBleeding';
    case 'medium':
    case 'mediumbleeding':
      return 'MediumBleeding';
    case 'heavy':
    case 'heavybleeding':
      return 'HeavyBleeding';
    default:
      return null;
  }
}

/**
 * Replicated state-bag write. Wrapped so a missing Source (player
 * dropped between the duty toggle's async lookup and the write)
 * doesn't bubble a native exception into the command dispatcher.
 */
function WriteBag(Source: number, Key: string, Value: unknown): void {
  try {
    Player(Source).state.set(Key, Value, true);
  } catch {
    // Player gone - state bag is moot anyway.
  }
}
