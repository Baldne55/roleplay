import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AccountSessionService } from '@/Services/AccountSessionService.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { DiscordService } from '@/Services/DiscordService.js';

declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;

/**
 * Finalisation step.
 *
 *   onNet AuthFinalize:
 *     1. Player must have an AccountID in PlayerState (set by
 *        AccountController.HandleJoin). If not, ignore (untrusted client).
 *     2. AccountSessionService.Claim(accountId, source) - drops any
 *        other Source already owning this account; we take over.
 *     3. PlayerState.SetPhase(Authenticated).
 *     4. Emit AuthSuccess with the cached display name + avatar so the
 *        UI can route to its post-auth view.
 *
 *   on playerDropped:
 *     Release the session claim so future joins for this account aren't
 *     immediately bumped.
 */
export class AuthController {
  private readonly Log = Logger.New('Auth');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Sessions: AccountSessionService,
    private readonly Accounts: AccountRepository,
    private readonly Characters: CharacterRepository,
    private readonly Discord: DiscordService,
  ) {
    onNet(NetEvents.AuthFinalize, (): void => {
      const Src = source;
      void this.HandleFinalize(Src);
    });

    on('playerDropped', (): void => {
      this.Sessions.Release(source);
    });

    this.Log.Info('Handlers registered (AuthFinalize, playerDropped -> session release)');
  }

  private async HandleFinalize(Src: number): Promise<void> {
    const PlayerState = this.State.Get(Src);
    if (PlayerState === null || PlayerState.AccountID === null) {
      this.Log.Warn(`AuthFinalize from source=${Src} with no AccountID; ignoring`);
      this.EmitFailure(Src, 'Your session is not ready. Please reconnect.');
      return;
    }

    try {
      // Pull the cached profile by ID. AccountController already wrote
      // fresh Discord fields on join; we just need the latest values to
      // pass to the UI for the post-auth view.
      const Account = await this.Accounts.FindByID(PlayerState.AccountID);
      if (Account === null) {
        this.Log.Error(`AuthFinalize: account ${PlayerState.AccountID} not found`);
        this.EmitFailure(Src, 'Account not found. Please reconnect.');
        return;
      }

      this.Sessions.Claim(PlayerState.AccountID, Src);
      this.State.SetPhase(Src, 'Authenticated');

      const AvatarURL =
        Account.DiscordID !== null && Account.DiscordAvatar !== null
          ? this.Discord.AvatarURL({ ID: Account.DiscordID, AvatarHash: Account.DiscordAvatar })
          : null;

      const Existing = await this.Characters.ListByAccount(PlayerState.AccountID);

      const Payload: NetEventPayloads[typeof NetEvents.AuthSuccess] = {
        DiscordDisplayName: Account.DiscordDisplayName ?? 'friend',
        DiscordAvatarURL: AvatarURL,
        HasCharacters: Existing.length > 0,
      };
      emitNet(NetEvents.AuthSuccess, Src, Payload);
      this.Log.Info(
        `Finalised source=${Src} account=${PlayerState.AccountID} characters=${Existing.length}`,
      );
    } catch (Err: unknown) {
      this.Log.Error(`AuthFinalize failed for source=${Src}`, { Err: String(Err) });
      this.EmitFailure(Src, 'Server error finalising sign-in. Please try again.');
    }
  }

  private EmitFailure(Src: number, Reason: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.AuthFailure] = { Reason };
    emitNet(NetEvents.AuthFailure, Src, Payload);
  }
}
