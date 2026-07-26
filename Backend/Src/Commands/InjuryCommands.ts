import { ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { InjuryService } from '@/Services/InjuryService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';

/**
 * Injury-cluster commands: /acceptdeath, /helpup, /arevive.
 *
 *   /acceptdeath  - 2-minute wait then respawn at nearest hospital.
 *                   Available in Unconscious, BadlyWounded, Dead.
 *   /helpup       - bystander lifts an unconscious player to HP=50
 *                   within 3 m. Caller must be Healthy themselves.
 *                   Floats `* Issuer helps Target up.` above the
 *                   issuer's head via the /ame nametag channel (fired
 *                   by InjuryService); the command Reply is a personal
 *                   Info confirmation.
 *   /arevive      - admin full restore to Healthy + HP=100. AdminDuty
 *                   gated by the dispatcher (RequiredStaffLevel +
 *                   SkipDutyCheck=false), no proximity. OOC toast only,
 *                   no IC narration.
 *
 * Every command runs as a thin pass-through to InjuryService - the
 * service holds the state machine and the persistence path; this module
 * only does arg parsing + outcome rendering.
 */
export function Register(
  Registry: CommandRegistry,
  Injury: InjuryService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Chat: ChatService,
  Accounts: AccountRepository,
): void {
  Registry.Add({
    Name: 'acceptdeath',
    Description: 'Accept your injuries and respawn at the nearest hospital.',
    Category: 'RP',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      // Founder + admin duty bypass - skips the 2-minute wait so devs
      // can probe the respawn / hospital flow without burning two
      // minutes per iteration. Mirrors the /pm self-PM and /to self-
      // target Founder exceptions; any other staff rank waits the
      // full timer.
      let BypassWait = false;
      if (Ctx.PlayerState.AdminDuty && Ctx.PlayerState.AccountID !== null) {
        const Account = await Accounts.FindByID(Ctx.PlayerState.AccountID);
        if (Account?.StaffLevel === 'Founder') BypassWait = true;
      }
      const Result = await Injury.AcceptDeath(Ctx.Source, BypassWait);
      if (Result.Ok) {
        return {
          Outcome: 'Ok',
          Reply: ChatFormatter.Info(
            `You have respawned at ${Result.Hospital.Name}.`,
          ),
        };
      }
      if ('RemainingMs' in Result) {
        const Seconds = Math.ceil(Result.RemainingMs / 1000);
        return {
          Outcome: 'BadArgs',
          Reason: `You must wait ${Seconds} more second(s) before accepting death.`,
        };
      }
      return { Outcome: 'BadArgs', Reason: Result.Reason };
    },
  });

  Registry.Add({
    Name: 'helpup',
    Description: 'Help an unconscious nearby player up (3 m).',
    Params: '<player_id>',
    Category: 'RP',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /helpup <player_id>' };
      }
      const Target = Number(Ctx.Args[0]);
      if (!Number.isFinite(Target) || !Number.isInteger(Target)) {
        return { Outcome: 'BadArgs', Reason: 'Player ID must be a number.' };
      }
      if (Target === Ctx.Source) {
        return { Outcome: 'BadArgs', Reason: 'You cannot help yourself up.' };
      }
      if (State.Get(Target)?.Phase !== 'Spawned') {
        return {
          Outcome: 'BadArgs',
          Reason: `Player ${Target} is not in the world.`,
        };
      }

      const Result = await Injury.HelpUp(Ctx.Source, Target);
      if (!Result.Ok) return { Outcome: 'BadArgs', Reason: Result.Reason };

      // The action float was already set on the issuer by InjuryService;
      // the command-side Reply is a personal Info confirmation so the
      // issuer sees a non-narration line that they actually did help.
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`You helped ${Result.TargetName} up.`),
      };
    },
  });

  Registry.Add({
    Name: 'arevive',
    Description: 'Admin: fully revive a player anywhere on the map.',
    Params: '<player_id>',
    Category: 'Admin',
    RequireCharacter: true,
    RequiredStaffLevel: 'Administrator',
    Run: async (Ctx): Promise<CommandResult> => {
      if (Ctx.Args.length === 0) {
        return { Outcome: 'BadArgs', Reason: 'Usage: /arevive <player_id>' };
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

      const TargetName = Broadcaster.DisplayName(Target) ?? `player ${Target}`;
      const Ok = await Injury.AdminRevive(Target);
      if (!Ok) {
        return {
          Outcome: 'BadArgs',
          Reason: `Could not revive ${TargetName}.`,
        };
      }
      if (Target !== Ctx.Source) {
        // Notify the target so they know why they snapped back to
        // Healthy mid-pose. OOC framing - this is admin-side mechanics
        // surfacing, not in-fiction. The Reply on the registry handles
        // the issuer side; the target needs a direct push.
        Chat.SendTo(Target, ChatFormatter.Info('An administrator has revived you.'));
      }
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`You revived ${TargetName}.`),
      };
    },
  });
}
