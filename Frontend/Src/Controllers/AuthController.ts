import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { NUIEvents } from '@Shared/Events/NUIEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';
import type { SpawnService } from '@/Services/SpawnService.js';

declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;

/**
 * Client-side auth orchestration. Pure passthrough between server
 * NetEvents and UI NUI messages plus the in-game ped/camera setup.
 *
 *   onNet  AuthInit       -> SpawnService.PrepareAuthShell, then NuiService.ShowAuth
 *   onNet  AuthPrepared   -> forward profile preview to UI for the welcome card
 *   onNet  AuthSuccess    -> forward to UI; UI routes to /Character/Select or /Character/Details
 *   onNet  AuthFailure    -> forward to UI; UI surfaces inline error
 *   NUI    AuthFinalize   -> emitNet AuthFinalize (UI "Enter Server" click)
 */
export class AuthController {
  private readonly Log = Logger.New('Auth');

  constructor(
    private readonly Spawn: SpawnService,
    private readonly Nui: NuiService,
  ) {
    onNet(NetEvents.AuthInit, (Payload: NetEventPayloads[typeof NetEvents.AuthInit]): void => {
      this.Log.Debug(`AuthInit received - bucket=${Payload.Bucket}`);
      this.HandleAuthInit(Payload).catch((Err: unknown) => {
        this.Log.Error('AuthInit handling failed', { Err: String(Err) });
      });
    });

    onNet(NetEvents.AuthPrepared, (Payload: NetEventPayloads[typeof NetEvents.AuthPrepared]): void => {
      this.Log.Debug(`AuthPrepared discord=${Payload.DiscordID} display="${Payload.DiscordDisplayName}"`);
      this.Nui.Send(NUIEvents.AuthPrepared, {
        DiscordDisplayName: Payload.DiscordDisplayName,
        DiscordAvatarURL: Payload.DiscordAvatarURL,
      });
    });

    onNet(NetEvents.AuthSuccess, (Payload: NetEventPayloads[typeof NetEvents.AuthSuccess]): void => {
      this.Log.Debug(
        `AuthSuccess display="${Payload.DiscordDisplayName}" hasCharacters=${Payload.HasCharacters}`,
      );
      this.Nui.Send(NUIEvents.AuthCompleted, {
        DiscordDisplayName: Payload.DiscordDisplayName,
        DiscordAvatarURL: Payload.DiscordAvatarURL,
        HasCharacters: Payload.HasCharacters,
        Settings: Payload.Settings,
      });
    });

    onNet(NetEvents.AuthFailure, (Payload: NetEventPayloads[typeof NetEvents.AuthFailure]): void => {
      this.Log.Warn(`AuthFailure: ${Payload.Reason}`);
      this.Nui.Send(NUIEvents.AuthFailed, { Reason: Payload.Reason });
    });

    this.Nui.OnCallback('AuthFinalize', (): void => {
      this.Log.Debug('UI requested finalize, emitting AuthFinalize to server');
      emitNet(NetEvents.AuthFinalize);
    });

    this.Log.Debug('Handlers registered (AuthInit, AuthPrepared, AuthSuccess, AuthFailure, NUI AuthFinalize)');
  }

  private async HandleAuthInit(Payload: NetEventPayloads[typeof NetEvents.AuthInit]): Promise<void> {
    await this.Spawn.PrepareAuthShell(Payload.SpawnCoord, Payload.Camera);
    this.Nui.ShowAuth();
  }
}
