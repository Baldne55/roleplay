import { NetEvents } from '@Shared/Events/NetEvents.js';
import { NUIEvents } from '@Shared/Events/NUIEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';
import type { SpawnService } from '@/Services/SpawnService.js';

// eslint-disable-next-line @typescript-eslint/naming-convention -- CitizenFX engine surface
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;

/**
 * Client-side bridge for mid-session "exit world" transitions.
 *
 *   onNet SessionReturnToSelect:
 *     Server has already persisted the runtime, cleared CharacterID, and
 *     flipped the routing bucket back to auth. We restore the skybox
 *     panorama and tell the SPA to bounce to /Character/Select.
 *
 *   onNet SessionReturnToAuth:
 *     Same skybox restore; SPA flips back to /Auth so the player can
 *     re-finalise. Focus comes back on the SPA so the Enter Server button
 *     is clickable.
 *
 * The server-side ChatService.Clear that runs alongside the transition
 * already flows through Chat's own ChatClear pipeline, so we don't have
 * to wipe scrollback from here.
 */
export class SessionController {
  private readonly Log = Logger.New('Session');

  constructor(
    private readonly Spawn: SpawnService,
    private readonly Nui: NuiService,
  ) {
    onNet(NetEvents.SessionReturnToSelect, (): void => {
      this.Log.Debug('SessionReturnToSelect received');
      this.HandleReturn(NUIEvents.SessionReturnToSelect).catch((Err: unknown) => {
        this.Log.Error('SessionReturnToSelect handling failed', { Err: String(Err) });
      });
    });

    onNet(NetEvents.SessionReturnToAuth, (): void => {
      this.Log.Debug('SessionReturnToAuth received');
      this.HandleReturn(NUIEvents.SessionReturnToAuth).catch((Err: unknown) => {
        this.Log.Error('SessionReturnToAuth handling failed', { Err: String(Err) });
      });
    });

    this.Log.Debug('Handlers registered (SessionReturnToSelect, SessionReturnToAuth)');
  }

  /**
   * Return the client to the auth or selector shell after the server
   * tears the session down (`/logout`, `/changecharacter`).
   *
   * Rebuilds the skybox shell and routes the SPA back, so the client ends
   * up in the same state as a fresh join without reconnecting.
   */
  private async HandleReturn(
    NuiEvent: typeof NUIEvents.SessionReturnToSelect | typeof NUIEvents.SessionReturnToAuth,
  ): Promise<void> {
    await this.Spawn.RestoreAuthShell();
    this.Nui.Focus(true);
    this.Nui.Send(NuiEvent, {});
  }
}
