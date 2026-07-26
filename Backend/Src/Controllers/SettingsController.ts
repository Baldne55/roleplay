import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import {
  AccountSettingsValidationError,
  type AccountSettingsService,
} from '@/Services/AccountSettingsService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Server-side settings bridge.
 *
 *   onNet SettingsUpdate:
 *     Player must have an AccountID in PlayerState. Validate + merge +
 *     persist via AccountSettingsService, then echo the resolved
 *     snapshot via SettingsPushed so the SPA's write-through completes.
 *
 * No playerDropped handler - the JSON column is durable and there's
 * no in-memory session state to release.
 */
export class SettingsController {
  private readonly Log = Logger.New('Settings');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Settings: AccountSettingsService,
  ) {
    onNet(
      NetEvents.SettingsUpdate,
      (Payload: NetEventPayloads[typeof NetEvents.SettingsUpdate]): void => {
        const Src = source;
        void this.HandleUpdate(Src, Payload).catch((Err: unknown) => {
          this.Log.Error(`HandleUpdate failed for source=${Src}`, { Err: String(Err) });
        });
      },
    );

    this.Log.Debug('Handlers registered (SettingsUpdate)');
  }

  /**
   * Apply a settings change from the SPA.
   *
   * Validated server-side and merged over existing values rather than
   * replacing them, so a client sending a partial object cannot blank the
   * settings it did not mention.
   */
  private async HandleUpdate(
    Src: number,
    Payload: NetEventPayloads[typeof NetEvents.SettingsUpdate],
  ): Promise<void> {
    const PlayerState = this.State.Get(Src);
    if (PlayerState === null || PlayerState.AccountID === null) {
      this.Log.Warn(`SettingsUpdate rejected: source=${Src} has no AccountID`);
      return;
    }

    try {
      const Resolved = await this.Settings.UpdateMerge(
        PlayerState.AccountID,
        Payload?.Settings ?? {},
      );
      const Echo: NetEventPayloads[typeof NetEvents.SettingsPushed] = { Settings: Resolved };
      emitNet(NetEvents.SettingsPushed, Src, Echo);
    } catch (Err: unknown) {
      if (Err instanceof AccountSettingsValidationError) {
        this.Log.Warn(
          `SettingsUpdate rejected: source=${Src} reason="${Err.Reason}"`,
        );
        return;
      }
      this.Log.Error(`SettingsUpdate failed for source=${Src}`, { Err: String(Err) });
    }
  }
}
