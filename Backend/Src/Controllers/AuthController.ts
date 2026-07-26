import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { ResolveAccountSettings } from '@Shared/Constants/AccountSettings.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AccountSessionService } from '@/Services/AccountSessionService.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { DiscordService } from '@/Services/DiscordService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
/* eslint-enable @typescript-eslint/naming-convention */

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
 * The session-claim release on disconnect lives in the
 * PlayerSessionService playerDropped dispatcher
 * (AccountSessionService.Release), so future joins for this account
 * aren't immediately bumped.
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
      void this.HandleFinalize(Src).catch((Err: unknown) => {
        this.Log.Error(`HandleFinalize failed for source=${Src}`, { Err: String(Err) });
      });
    });

    this.Log.Debug('Handlers registered (AuthFinalize)');
  }

  /**
   * Complete sign-in after the player confirms on the auth card, then
   * route them to the selector or straight into character creation
   * depending on whether they own any characters.
   *
   * Identity was already established during the connection handshake -
   * this only converts a confirmed click into a session.
   */
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

      const ResolvedSettings = ResolveAccountSettings(Account.Settings);
      // Mirror the local-only nametag preferences into LocalPlayer state
      // bag so the Frontend NametagController can read them every frame
      // without a round-trip through the SPA. Done here (Authenticated
      // phase) so the values are in place before CharacterSpawned fires.
      try {
        Player(Src).state.set(
          NametagBagKeys.SelfVisible,
          ResolvedSettings.NametagSelfVisible,
          true,
        );
        Player(Src).state.set(
          NametagBagKeys.IDVisible,
          ResolvedSettings.NametagIDVisible,
          true,
        );
      } catch (Err: unknown) {
        this.Log.Warn(`Nametag bag seed failed for source=${Src}`, { Err: String(Err) });
      }

      const Payload: NetEventPayloads[typeof NetEvents.AuthSuccess] = {
        DiscordDisplayName: Account.DiscordDisplayName ?? 'friend',
        DiscordAvatarURL: AvatarURL,
        HasCharacters: Existing.length > 0,
        // Resolved (defaults-merged) so the SPA receives a fully
        // populated object - no client-side default-filling needed.
        Settings: ResolvedSettings,
      };
      emitNet(NetEvents.AuthSuccess, Src, Payload);
      this.Log.Debug(
        `Finalised source=${Src} account=${PlayerState.AccountID} characters=${Existing.length}`,
      );
    } catch (Err: unknown) {
      this.Log.Error(`AuthFinalize failed for source=${Src}`, { Err: String(Err) });
      this.EmitFailure(Src, 'Server error finalising sign-in. Please try again.');
    }
  }

  /**
   * Send a sign-in failure to the card, which re-enables its button - the
   * failure is recoverable, since the usual causes are transient.
   */
  private EmitFailure(Src: number, Reason: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.AuthFailure] = { Reason };
    emitNet(NetEvents.AuthFailure, Src, Payload);
  }
}
