import { AuthCinematicCamera, AuthSpawnCoord } from '@Shared/Constants/AuthSkybox.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import type { DiscordService } from '@/Services/DiscordService.js';
import type { AccountService } from '@/Services/AccountService.js';
import type { ServerConfig } from '@/Infrastructure/Config/ServerConfig.js';

declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function DropPlayer(PlayerSrc: string | number, Reason: string): void;
declare function GetPlayerIdentifierByType(PlayerSrc: string, Type: string): string | undefined;
declare function GetPlayerEndpoint(PlayerSrc: string): string;
declare function GetPlayerName(PlayerSrc: string): string;

/**
 * Account lifecycle + identity gate.
 *
 *   playerJoining:
 *     1. Read discord IPC identifier - missing => kick.
 *     2. Check guild membership via bot token - not in guild => kick.
 *     3. Fetch Discord profile via bot token.
 *     4. UpsertFromDiscord (creates a Pending row if needed, refreshes
 *        cached profile + audit fields otherwise; never mutates Status).
 *     5. Banned account => kick.
 *     6. Pending account => kick with UCP URL (player must pass the
 *        roleplay quiz; UCP flips them to Active out-of-band).
 *     7. Assign routing bucket; init PlayerState (Phase=PreAuth,
 *        AccountID set).
 *     8. Emit AuthInit (skybox config) + AuthPrepared (profile preview).
 *
 *   playerDropped:
 *     Clear PlayerState. Session-table release lives in AuthController.
 */
export class AccountController {
  private readonly Log = Logger.New('Account');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Routing: RoutingBucketService,
    private readonly Discord: DiscordService,
    private readonly Accounts: AccountService,
    private readonly Config: ServerConfig,
  ) {
    on('playerJoining', (): void => {
      const Src = source;
      void this.HandleJoin(Src);
    });

    on('playerDropped', (): void => {
      this.State.Clear(source);
    });

    this.Log.Info('Handlers registered (playerJoining -> gate, playerDropped -> clear)');
  }

  private async HandleJoin(Src: number): Promise<void> {
    try {
      const License = ExtractLicense(Src);
      if (License === null) {
        this.Kick(Src, 'Your FXServer connection has no license identifier. Reconnect.');
        return;
      }

      const DiscordID = ExtractDiscordID(Src);
      if (DiscordID === null) {
        this.Kick(
          Src,
          'Discord must be running and logged in on this machine to play. Open Discord, then reconnect.',
        );
        return;
      }

      const InGuild = await this.Discord.IsGuildMember(DiscordID);
      if (!InGuild) {
        this.Kick(Src, `You must join our Discord to play: ${this.Config.DiscordGuildInvite}`);
        return;
      }

      const Profile = await this.Discord.FetchProfile(DiscordID);
      const Account = await this.Accounts.UpsertFromDiscord(Profile, {
        License,
        IP: SafeEndpoint(Src),
        SocialClubName: SafeName(Src),
      });

      if (Account.Status === 'Banned') {
        this.Log.Warn(`Banned account tried to join: id=${Account.ID} discord=${DiscordID}`);
        this.Kick(Src, 'This account is banned.');
        return;
      }

      if (Account.Status === 'Pending') {
        this.Log.Info(`Pending account held at gate: id=${Account.ID} discord=${DiscordID}`);
        this.Kick(
          Src,
          `Your account is pending. Complete the roleplay quiz to be approved: ${this.Config.UCPUrl}`,
        );
        return;
      }

      const Bucket = this.Routing.AssignAuthBucket(Src);
      const PlayerState = this.State.Initialise(Src, Bucket);
      PlayerState.AccountID = Account.ID;

      const InitPayload: NetEventPayloads[typeof NetEvents.AuthInit] = {
        SpawnCoord: AuthSpawnCoord,
        Camera: AuthCinematicCamera,
        Bucket,
      };
      emitNet(NetEvents.AuthInit, Src, InitPayload);

      const PreparedPayload: NetEventPayloads[typeof NetEvents.AuthPrepared] = {
        DiscordID: Profile.ID,
        DiscordDisplayName: Profile.DisplayName,
        DiscordAvatarURL: this.Discord.AvatarURL(Profile),
      };
      emitNet(NetEvents.AuthPrepared, Src, PreparedPayload);

      this.Log.Info(
        `Gated source=${Src} account=${Account.ID} discord=${DiscordID} display="${Profile.DisplayName}"`,
      );
    } catch (Err: unknown) {
      this.Log.Error(`playerJoining gate failed for source=${Src}`, { Err: String(Err) });
      this.Kick(Src, 'Server error during identity check. Try again in a moment.');
    }
  }

  private Kick(Src: number, Reason: string): void {
    try {
      DropPlayer(Src, Reason);
    } catch (Err: unknown) {
      this.Log.Warn(`DropPlayer(${Src}) threw`, { Err: String(Err) });
    }
  }
}

function ExtractLicense(Src: number): string | null {
  const Raw = GetPlayerIdentifierByType(String(Src), 'license');
  if (typeof Raw !== 'string' || Raw.length === 0) return null;
  return Raw.startsWith('license:') ? Raw.slice(8) : Raw;
}

function ExtractDiscordID(Src: number): string | null {
  const Raw = GetPlayerIdentifierByType(String(Src), 'discord');
  if (typeof Raw !== 'string' || Raw.length === 0) return null;
  return Raw.startsWith('discord:') ? Raw.slice(8) : Raw;
}

function SafeEndpoint(Src: number): string | null {
  try {
    const Raw = GetPlayerEndpoint(String(Src));
    if (typeof Raw !== 'string' || Raw.length === 0) return null;
    const ColonIdx = Raw.lastIndexOf(':');
    return ColonIdx === -1 ? Raw : Raw.slice(0, ColonIdx);
  } catch {
    return null;
  }
}

function SafeName(Src: number): string | null {
  try {
    const Raw = GetPlayerName(String(Src));
    return typeof Raw === 'string' && Raw.length > 0 ? Raw : null;
  } catch {
    return null;
  }
}
