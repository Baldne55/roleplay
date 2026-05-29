import { AuthCinematicCamera, AuthSpawnCoord } from '@Shared/Constants/AuthSkybox.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { ChatColor, ChatFormatter, Sanitize } from '@Shared/Chat/Index.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import type { DiscordService } from '@/Services/DiscordService.js';
import type { AccountService } from '@/Services/AccountService.js';
import type { ChatService } from '@/Services/ChatService.js';
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
    private readonly Chat: ChatService,
    private readonly Config: ServerConfig,
  ) {
    on('playerJoining', (): void => {
      const Src = source;
      void this.HandleJoin(Src);
    });

    on('playerDropped', (): void => {
      this.State.Clear(source);
    });

    this.Log.Debug('Handlers registered (playerJoining -> gate, playerDropped -> clear)');
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

      // Welcome line - rides the same chat pipe used for /help replies.
      // Sanitize the display name so a player-set Discord nickname can't
      // sneak `!{#hex}` tokens past the parser. ".mp" tinted with the
      // PrimeVue Aura primary so the chat brand matches the SPA chrome.
      const SanitisedName = Sanitize(Profile.DisplayName).trim();
      const NameOrFallback = SanitisedName.length > 0 ? SanitisedName : 'friend';
      this.Chat.SendTo(
        Src,
        ChatFormatter.OOC(
          `Welcome to Legacy!{${ChatColor.Primary}}.mp!{${ChatColor.White}} - Roleplay, ${NameOrFallback}.`,
        ),
      );

      // Notice block - the per-connection disclaimer. Strict-formal
      // register per feedback_prose_voice_formal.md. Block framing (60
      // chars) matches the visual-v2 info-dump convention.
      for (const Line of NoticeLines) {
        this.Chat.SendTo(Src, Line);
      }

      this.Log.Debug(
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

/**
 * Per-connection notice block. Static at module scope so the strings are
 * built once at boot, not on every join. The opening Header / closing
 * Footer wrap the disclaimer body in the 60-char block convention used
 * elsewhere for help-style info dumps.
 *
 * Coverage:
 *   - Non-commercial status.
 *   - No affiliation with Rockstar Games or Take-Two Interactive.
 *   - Age-of-majority expectation + mature-content warning.
 *   - Implicit rules acceptance on continued play.
 */
/**
 * Brand fragment used inside the notice body. Built once at module scope
 * so the colour tokens around `.mp` are consistent everywhere the brand
 * appears (welcome line + notice body).
 */
const Brand = `Legacy!{${ChatColor.Primary}}.mp!{${ChatColor.White}}`;

const NoticeLines: readonly string[] = [
  // Block framing in emerald to match the `.mp` accent in the welcome
  // line. The default red is reserved for ERROR / ADMIN context, which
  // this is not. Body lines wear the `(( ))` OOC wrap; the header and
  // footer are decorative borders, not narration.
  ChatFormatter.Header('Notice', ChatColor.Primary),
  ChatFormatter.OOC(`${Brand} is a non-monetized roleplay community.`),
  ChatFormatter.OOC(
    `${Brand} is not affiliated with Rockstar Games, Take-Two Interactive, or any of their parent companies, subsidiaries, or rights holders.`,
  ),
  ChatFormatter.OOC('Players must be of legal adult age in their country of residence.'),
  ChatFormatter.OOC(
    'Roleplay may depict violence, injury, and other content unsuitable for minors.',
  ),
  ChatFormatter.OOC('Continued play constitutes acceptance of all server rules.'),
  ChatFormatter.Footer(ChatColor.Primary),
];

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
