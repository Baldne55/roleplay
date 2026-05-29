import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandHint } from '@Shared/Chat/Index.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function GetPlayers(): string[];

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

  SendTo(Source: number, Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    emitNet(NetEvents.ChatPush, Source, Payload);
  }

  BroadcastAll(Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    emitNet(NetEvents.ChatPush, -1, Payload);
  }

  BroadcastToSpawned(Body: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatPush] = { Body };
    let Count = 0;
    for (const Raw of GetPlayers()) {
      const Source = Number(Raw);
      if (!Number.isFinite(Source)) continue;
      if (this.State.Get(Source)?.Phase !== 'Spawned') continue;
      emitNet(NetEvents.ChatPush, Source, Payload);
      Count += 1;
    }
    this.Log.Debug(`BroadcastToSpawned reached ${Count} player(s)`);
  }

  PushCommandList(Source: number, Commands: CommandHint[]): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatCommandList] = { Commands };
    emitNet(NetEvents.ChatCommandList, Source, Payload);
  }

  Clear(Source: number): void {
    const Payload: NetEventPayloads[typeof NetEvents.ChatClear] = {};
    emitNet(NetEvents.ChatClear, Source, Payload);
  }
}
