import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};

/**
 * Admin-duty surface. /aduty is the gate that unblocks staff commands -
 * the registry's RequiredStaffLevel check also enforces AdminDuty by
 * default, so without this toggle a staff member could never reach any
 * staff command. SkipDutyCheck=true is mandatory here for that reason.
 * /admins is the public lookup any player can run; it resolves names
 * through the broadcaster's mask-aware DisplayName so masked staff do
 * not leak identity through the on-duty roster.
 */
export function Register(
  Registry: CommandRegistry,
  State: PlayerStateService,
  Accounts: AccountRepository,
  Broadcaster: ProximityBroadcaster,
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
      } else {
        WriteBag(Ctx.Source, NametagBagKeys.AdminDuty, false);
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyLabel, '');
        WriteBag(Ctx.Source, NametagBagKeys.AdminDutyName, '');
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
