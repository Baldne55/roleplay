import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandHint } from '@Shared/Chat/Index.js';
import { DebugEnabled, Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

// eslint-disable-next-line @typescript-eslint/naming-convention -- CitizenFX engine surface
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;

/**
 * Server -> client transport for chat lines and chat-domain metadata.
 *
 * Body strings are the canonical `!{#RRGGBB}...!{#FFFFFF}` token format;
 * composing them is the caller's job (typically via ChatFormatter). This
 * service is the wire layer only - it does not validate, sanitize, or
 * format.
 *
 * BroadcastToSpawned is the safe default for player-visible broadcasts:
 * it filters out anyone still in the auth shell so connecting players
 * don't see in-world chatter through their skybox.
 */
export class ChatService {
  private readonly Log = Logger.New('Chat');

  constructor(private readonly State: PlayerStateService) {}

  /** Push one line to one player. The primitive every other method builds on. */
  SendTo(Source: number, Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    emitNet(NetEvents.ChatPush, Source, Payload);
  }

  /**
   * Push to every connected client, including players still in the auth
   * shell. Rarely what you want - prefer BroadcastToSpawned, so a
   * connecting player does not see in-world chatter through their skybox.
   */
  BroadcastAll(Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    emitNet(NetEvents.ChatPush, -1, Payload);
  }

  /**
   * Push to every player who has a character in the world. The safe
   * default for anything player-visible.
   */
  BroadcastToSpawned(Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    const Spawned = this.State.GetSpawnedSources();
    for (const Source of Spawned) {
      emitNet(NetEvents.ChatPush, Source, Payload);
    }
    if (DebugEnabled()) {
      this.Log.Debug(`BroadcastToSpawned reached ${Spawned.length} player(s)`);
    }
  }

  /**
   * Send the player their autocomplete list.
   *
   * Already permission-filtered by the caller, which is what stops the UI
   * suggesting commands the player's staff level cannot run - the client
   * never learns they exist.
   */
  PushCommandList(Source: number, Commands: CommandHint[]): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatCommandList] = { Commands };
    emitNet(NetEvents.ChatCommandList, Source, Payload);
  }

  /** Wipe one player's local scrollback (`/clearchat`). */
  Clear(Source: number): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatClear] = {};
    emitNet(NetEvents.ChatClear, Source, Payload);
  }
}
