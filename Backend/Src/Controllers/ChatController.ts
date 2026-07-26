import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import {
  ChatBodyMaxLength,
  ChatColor,
  ChatFormatter,
  Sanitize,
  type CommandHint,
} from '@Shared/Chat/Index.js';
import { Logger } from '@/Util/Logger.js';
import { HasActivePremium } from '@/Data/Models/Account.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { ChatRateLimiter } from '@/Services/ChatRateLimiter.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Chat I/O orchestrator.
 *
 *   onNet ChatSubmit:
 *     1. Phase gate - reject anything not Spawned.
 *     2. Token-bucket rate limit (5 capacity, 1/400ms refill).
 *     3. Sanitize + trim + length cap.
 *     4. Dispatch through the command registry and translate the
 *        CommandResult into a chat line.
 *
 *     Step 4 handles slashed and unslashed input alike: a body with no
 *     leading '/' is rewritten to `/say <body>` rather than handled
 *     separately, so the registry stays the single owner of permission
 *     gating, cooldown stamping and formatter selection. There is no
 *     second broadcast path to keep in sync.
 *
 *   onNet ChatTypingState:
 *     Server-authoritative typing indicator. The client reports its
 *     input focus rather than writing the replicated bag itself, which
 *     keeps the `Roleplay:` bag namespace server-owned.
 *
 *   Evict (invoked by the PlayerSessionService playerDropped
 *   dispatcher):
 *     Drop both the rate-limit bucket and the registry cooldown map
 *     entries for the source. Symmetric hygiene.
 *
 *   PushCommandListToSource(Source):
 *     Snapshot the registry into CommandHint[] and emit it. Called by
 *     CharacterController after the spawn handoff.
 *
 *   PushSpawnWelcome(Source, FirstName, LastName):
 *     Clear the auth-shell scrollback and print the spawn card. Also
 *     called by CharacterController after the spawn handoff.
 */
export class ChatController {
  private readonly Log = Logger.New('ChatController');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Registry: CommandRegistry,
    private readonly Chat: ChatService,
    private readonly RateLimit: ChatRateLimiter,
    private readonly Accounts: AccountRepository,
    private readonly Runtimes: CharacterRuntimeService,
  ) {
    onNet(
      NetEvents.ChatSubmit,
      (Payload: NetEventPayloads[typeof NetEvents.ChatSubmit]): void => {
        const Src = source;
        void this.HandleSubmit(Src, Payload).catch((Err: unknown) => {
          this.Log.Error(`HandleSubmit failed for source=${Src}`, { Err: String(Err) });
        });
      },
    );

    onNet(
      NetEvents.ChatTypingState,
      (Payload: NetEventPayloads[typeof NetEvents.ChatTypingState]): void => {
        const Src = source;
        // Server-authoritative typing indicator: the client emits its
        // focus on/off here instead of writing the replicated bag, so
        // the `Roleplay:` namespace stays server-owned. Phase gate keeps
        // an out-of-world sender from stamping a nametag bag.
        if (this.State.Get(Src)?.Phase !== 'Spawned') return;
        this.Runtimes.SetTyping(Src, Payload?.On === true);
      },
    );

    this.Log.Debug('Handlers registered (ChatSubmit, ChatTypingState)');
  }

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Drops the rate-limit bucket and the
   * registry cooldown entries. Symmetric hygiene.
   */
  Evict(Source: number): void {
    this.Registry.Evict(Source);
    this.RateLimit.Evict(Source);
  }

  /**
   * Send one player their autocomplete list, filtered to what their staff
   * level may actually run - a player never receives a hint for a command
   * they cannot use, so the client cannot leak the admin surface.
   */
  PushCommandListToSource(Source: number): void {
    const Commands: CommandHint[] = this.Registry.GetAll().map((Def) => ({
      Name: Def.Name,
      Aliases: Def.Aliases,
      Params: Def.Params,
      Description: Def.Description,
      Category: Def.Category,
    }));
    this.Chat.PushCommandList(Source, Commands);
    this.Log.Debug(`Pushed ${Commands.length} command hint(s) to source=${Source}`);
  }

  /**
   * Spawn-time welcome card. Modelled on lc-rp's SendWelcomeCard
   * (CharacterController.cs:474-523):
   *   - Header (emerald, matching the per-connection notice block).
   *   - Character: FirstName LastName (DiscordDisplayName).
   *   - Player ID: numeric Source.
   *   - Staff: rank, only when StaffLevel != 'None'.
   *   - Premium: tier + expiry suffix, only when HasActivePremium.
   *   - Footer (emerald).
   *
   * Reads the Account fresh so a /setstaff or premium tier flip mid-
   * session shows up on the next spawn without a reconnect.
   */
  async PushSpawnWelcome(Source: number, FirstName: string, LastName: string): Promise<void> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.AccountID === null) return;
    const Account = await this.Accounts.FindByID(PlayerState.AccountID);
    if (Account === null) return;

    // Wipe the auth-shell scrollback (welcome line + notice block) so
    // the spawn card lands in a clean panel. The notice has already
    // been seen by the player at this point.
    this.Chat.Clear(Source);

    const DisplayName = Account.DiscordDisplayName ?? 'Unknown';
    const Lines: string[] = [
      ChatFormatter.Header('Welcome Back', ChatColor.Primary),
      ChatFormatter.OOC(
        ChatFormatter.Label('Character', `${FirstName} ${LastName} (${DisplayName})`),
      ),
      ChatFormatter.OOC(ChatFormatter.Label('Player ID', String(Source))),
    ];
    if (Account.StaffLevel !== 'None') {
      Lines.push(ChatFormatter.OOC(ChatFormatter.Label('Staff', Account.StaffLevel)));
    }
    if (HasActivePremium(Account)) {
      const Suffix =
        Account.PremiumExpiresAt === null
          ? ' (lifetime)'
          : ` (expires ${Account.PremiumExpiresAt.toISOString().slice(0, 10)})`;
      Lines.push(
        ChatFormatter.OOC(
          ChatFormatter.Label('Premium', `${Account.PremiumTier}${Suffix}`),
        ),
      );
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Primary));

    for (const Line of Lines) {
      this.Chat.SendTo(Source, Line);
    }
  }

  /**
   * Ingress for everything a player types.
   *
   * Order is the security-relevant part: rate-limit, then sanitise colour
   * tokens out of the raw body, then dispatch as a command or as speech.
   * Sanitising at ingress is what guarantees no player-authored `!{#...}`
   * token can ever reach a rendered line, whatever path it takes
   * afterwards - including being persisted and replayed later.
   */
  private async HandleSubmit(
    Src: number,
    Payload: NetEventPayloads[typeof NetEvents.ChatSubmit],
  ): Promise<void> {
    if (this.State.Get(Src)?.Phase !== 'Spawned') {
      this.Log.Warn(`ChatSubmit dropped: source=${Src} not Spawned`);
      return;
    }

    if (!this.RateLimit.TryConsume(Src)) {
      this.Chat.SendTo(Src, ChatFormatter.Error('You are sending messages too quickly.'));
      return;
    }

    const Raw = typeof Payload?.Body === 'string' ? Payload.Body : '';
    const Body = Sanitize(Raw).trim();
    if (Body.length === 0) return;
    if (Body.length > ChatBodyMaxLength) {
      this.Chat.SendTo(Src, ChatFormatter.Usage(`Message exceeds ${ChatBodyMaxLength} characters.`));
      return;
    }

    // Default IC channel is /say. Plain text without a leading slash is
    // routed through the same dispatcher path as `/say <body>` so the
    // registry remains the single owner of broadcast (permission gate,
    // cooldown stamping, rate-limit accounting, formatter selection).
    const Dispatched = Body[0] === '/' ? Body : `/say ${Body}`;
    try {
      const Result = await this.Registry.Dispatch(Src, Dispatched);
      this.RenderOutcome(Src, Result);
    } catch (Err: unknown) {
      this.Log.Error(`Dispatch threw for source=${Src}`, { Err: String(Err) });
      this.Chat.SendTo(Src, ChatFormatter.Error('Server error processing command.'));
    }
  }

  /**
   * Translate a CommandResult into a chat line and send it. The registry
   * never knows about chat - this is the only place each Outcome variant
   * is given a rendering.
   */
  private RenderOutcome(Src: number, Result: CommandResult): void {
    switch (Result.Outcome) {
      case 'Ok':
        if (Result.Reply !== undefined && Result.Reply.length > 0) {
          this.Chat.SendTo(Src, Result.Reply);
        }
        return;
      case 'UnknownCommand':
        this.Chat.SendTo(
          Src,
          ChatFormatter.Error(`Unknown command /${Result.Name}.`),
        );
        return;
      case 'PermissionDenied':
        this.Chat.SendTo(
          Src,
          ChatFormatter.Error('You do not have permission to use this command.'),
        );
        return;
      case 'NotOnDuty':
        this.Chat.SendTo(
          Src,
          ChatFormatter.Error('You must be on admin duty to use this command. Use /aduty.'),
        );
        return;
      case 'RequiresCharacter':
        this.Chat.SendTo(
          Src,
          ChatFormatter.Error('You must be in-world with a character to use this command.'),
        );
        return;
      case 'OnCooldown': {
        const Seconds = Math.max(1, Math.ceil(Result.RemainingMs / 1000));
        this.Chat.SendTo(
          Src,
          ChatFormatter.Warning(`Wait ${Seconds}s before using that command again.`),
        );
        return;
      }
      case 'BadArgs':
        this.Chat.SendTo(Src, ChatFormatter.Usage(Result.Reason));
        return;
      case 'HandlerError':
        this.Chat.SendTo(Src, ChatFormatter.Error('Command failed. Try again.'));
        return;
      default: {
        const _Unhandled: never = Result;
        void _Unhandled;
      }
    }
  }
}
