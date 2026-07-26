import { ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { PrivateMessageStore } from '@/Services/PrivateMessageStore.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';

/**
 * Private-message cluster - /pm, /reply, /blockpm, /unblockpm.
 *
 * Names are resolved through Broadcaster.DisplayName, the mask-aware
 * identity chokepoint. A masked character renders as `Stranger <MaskID>`,
 * so their legal name never leaks through a PM. The OOC server ID is
 * prepended per-viewer (the other party's id) when the viewer has the
 * nametag-ID toggle on, matching the speech + nametag behavior - the
 * server ID is the same OOC handle the nametag already exposes, kept
 * distinct from the masked IC identity.
 *
 * Block semantics: when the target's account has blocked the sender's
 * account, both the recipient's PmFrom and the sender's PmTo are
 * dropped; the sender gets a neutral "could not be delivered" error
 * that is indistinguishable from sending to an offline player, so the
 * block does not out the blocker. Earlier builds let the sender's
 * PmTo through under the ragemp / lc-rp "silent ignore" convention,
 * but that read as a successful send from the sender's chat surface
 * and the message effectively went out from their point of view.
 *
 * Self-PM is rejected by default. The single exception is the highest
 * staff rank (Founder) on admin duty - they can /pm themselves to
 * probe the format / colour pipeline live without needing a second
 * client.
 */

/**
 * Prepend the per-viewer server-ID prefix to a PM line. The `Viewer`
 * (who receives this line) sees the OTHER party's server `ShownId` lead
 * the line when they have the nametag-ID toggle on - the same
 * preference and OOC handle the nametag + speech IDs use. Shown
 * regardless of mask, consistent with the nametag.
 */
function WithViewerId(
  Broadcaster: ProximityBroadcaster,
  Viewer: number,
  ShownId: number,
  Line: string,
): string {
  return Broadcaster.WantsServerIds(Viewer) ? ChatFormatter.ServerIdPrefix(ShownId) + Line : Line;
}

/**
 * Wire the private-message commands.
 *
 * PMs are out-of-character and ignore proximity entirely, so they carry
 * the OOC wrap to keep that boundary visible. Distinct from the other
 * distance-independent channels: `/o` is server-wide and staff-gated,
 * radio and phone are in-character and route through a device, while a PM
 * is player-to-player with no in-world justification at all.
 *
 * The store exists so `/reply` works without retyping an id.
 */
export function Register(
  Registry: CommandRegistry,
  Chat: ChatService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Store: PrivateMessageStore,
  Accounts: AccountRepository,
): void {
  Registry.Add({
    Name: 'pm',
    Aliases: ['dm'],
    Description: 'Send a private message to another player.',
    Params: '<player_id> <message>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length < 2) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /pm <player_id> <message>' };
      }

      const Target = Number(Ctx.Args[0]);
      if (!Number.isFinite(Target) || !Number.isInteger(Target)) {
        return { Outcome: 'BadArgs', Reason: 'Player ID must be a number.' };
      }

      if (Target === Ctx.Source) {
        if (
          Ctx.PlayerState.AccountID === null ||
          !Ctx.PlayerState.AdminDuty
        ) {
          return { Outcome: 'BadArgs', Reason: 'You cannot PM yourself.' };
        }
        const Account = await Accounts.FindByID(Ctx.PlayerState.AccountID);
        if (Account === null || Account.StaffLevel !== 'Founder') {
          return { Outcome: 'BadArgs', Reason: 'You cannot PM yourself.' };
        }
      } else if (State.Get(Target)?.Phase !== 'Spawned') {
        return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
      }

      const Body = Ctx.Args.slice(1).join(' ').trim();
      if (Body.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Message body is required.' };
      }

      const SenderName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const RecipientName = Broadcaster.DisplayName(Target) ?? 'Someone';

      // Check the block BEFORE acking the sender. A sender who sees
      // their own PmTo line believes the message landed - that's the
      // surface the user flagged as "the blocked player can still
      // send the PM". The neutral wording matches the offline-target
      // error above so the blocker isn't outed by the error itself.
      // Self-PM is exempt (Founder format probe; you can't block
      // yourself anyway).
      if (
        Target !== Ctx.Source &&
        RecipientBlockedSender(Store, State, Ctx, Target)
      ) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Your message could not be delivered.',
        };
      }

      Chat.SendTo(
        Ctx.Source,
        WithViewerId(Broadcaster, Ctx.Source, Target, ChatFormatter.PmTo(RecipientName, Body)),
      );

      if (Target === Ctx.Source) {
        // Founder self-PM: deliver the From-side line on the same
        // connection so both formats render for format probing.
        Chat.SendTo(
          Ctx.Source,
          WithViewerId(Broadcaster, Ctx.Source, Ctx.Source, ChatFormatter.PmFrom(SenderName, Body)),
        );
      } else {
        Chat.SendTo(
          Target,
          WithViewerId(Broadcaster, Target, Ctx.Source, ChatFormatter.PmFrom(SenderName, Body)),
        );
      }

      Store.Record(Ctx.Source, Target);
      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'reply',
    Aliases: ['rm'],
    Description: 'Reply to the player who most recently PMed you.',
    Params: '<message>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Target = Store.LastSenderTo(Ctx.Source);
      if (Target === null) {
        return { Outcome: 'BadArgs', Reason: 'You have no recent PM to reply to.' };
      }

      if (State.Get(Target)?.Phase !== 'Spawned') {
        return {
          Outcome: 'BadArgs',
          Reason: 'The other player is no longer in the world.',
        };
      }

      const Body = Ctx.Args.join(' ').trim();
      if (Body.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Message body is required.' };
      }

      const SenderName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const RecipientName = Broadcaster.DisplayName(Target) ?? 'Someone';

      if (RecipientBlockedSender(Store, State, Ctx, Target)) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Your message could not be delivered.',
        };
      }

      Chat.SendTo(
        Ctx.Source,
        WithViewerId(Broadcaster, Ctx.Source, Target, ChatFormatter.PmTo(RecipientName, Body)),
      );
      Chat.SendTo(
        Target,
        WithViewerId(Broadcaster, Target, Ctx.Source, ChatFormatter.PmFrom(SenderName, Body)),
      );
      Store.Record(Ctx.Source, Target);

      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'blockpm',
    Description: 'Stop seeing private messages from a player.',
    Params: '<player_id>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Resolved = ResolveBlockTarget(State, Ctx);
      if (Resolved.Outcome !== 'Ok') return Resolved.Result;
      const Added = Store.AddBlock(Resolved.SelfAccount, Resolved.TargetAccount);
      const Name = Broadcaster.DisplayName(Resolved.Target) ?? `player ${Resolved.Target}`;
      return {
        Outcome: 'Ok',
        Reply: Added
          ? ChatFormatter.Info(`You will no longer receive PMs from ${Name}.`)
          : ChatFormatter.Info(`${Name} is already blocked.`),
      };
    },
  });

  Registry.Add({
    Name: 'unblockpm',
    Description: 'Resume seeing private messages from a player.',
    Params: '<player_id>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Resolved = ResolveBlockTarget(State, Ctx);
      if (Resolved.Outcome !== 'Ok') return Resolved.Result;
      const Removed = Store.RemoveBlock(Resolved.SelfAccount, Resolved.TargetAccount);
      const Name = Broadcaster.DisplayName(Resolved.Target) ?? `player ${Resolved.Target}`;
      return {
        Outcome: 'Ok',
        Reply: Removed
          ? ChatFormatter.Info(`PM block on ${Name} removed.`)
          : ChatFormatter.Info(`${Name} was not blocked.`),
      };
    },
  });
}

/**
 * Returns true when the target's account has blocked the sender's
 * account. Used by /pm and /reply to skip the recipient-side delivery.
 * Both sides need an AccountID; when either is missing (race against
 * disconnect, runtime gap) the block check is treated as "not blocked"
 * so the message at least gets a chance.
 */
function RecipientBlockedSender(
  Store: PrivateMessageStore,
  State: PlayerStateService,
  Ctx: { Source: number; PlayerState: { AccountID: string | null } },
  Target: number,
): boolean {
  const SenderAccount = Ctx.PlayerState.AccountID;
  const TargetAccount = State.Get(Target)?.AccountID;
  if (SenderAccount === null || TargetAccount === null || TargetAccount === undefined) {
    return false;
  }
  return Store.IsBlocked(TargetAccount, SenderAccount);
}

/**
 * Parse + validate the `<player_id>` argument shared by /blockpm and
 * /unblockpm. Returns an Outcome=Ok branch with the resolved Source +
 * both AccountIDs, or an Outcome=Err branch that the caller forwards
 * to the dispatcher.
 */
function ResolveBlockTarget(
  State: PlayerStateService,
  Ctx: {
    Source: number;
    Args: string[];
    PlayerState: { AccountID: string | null };
  },
):
  | { Outcome: 'Ok'; Target: number; SelfAccount: string; TargetAccount: string }
  | { Outcome: 'Err'; Result: CommandResult } {
  if (Ctx.Args.length === 0) {
    return {
      Outcome: 'Err',
      Result: { Outcome: 'BadArgs', Reason: 'Usage: /blockpm <player_id>' },
    };
  }
  const Target = Number(Ctx.Args[0]);
  if (!Number.isFinite(Target) || !Number.isInteger(Target)) {
    return {
      Outcome: 'Err',
      Result: { Outcome: 'BadArgs', Reason: 'Player ID must be a number.' },
    };
  }
  if (Target === Ctx.Source) {
    return {
      Outcome: 'Err',
      Result: { Outcome: 'BadArgs', Reason: 'You cannot block yourself.' },
    };
  }
  const TargetState = State.Get(Target);
  if (TargetState?.Phase !== 'Spawned' || TargetState.AccountID === null) {
    return {
      Outcome: 'Err',
      Result: { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` },
    };
  }
  if (Ctx.PlayerState.AccountID === null) {
    return { Outcome: 'Err', Result: { Outcome: 'PermissionDenied' } };
  }
  return {
    Outcome: 'Ok',
    Target,
    SelfAccount: Ctx.PlayerState.AccountID,
    TargetAccount: TargetState.AccountID,
  };
}
