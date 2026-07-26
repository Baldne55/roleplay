import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { NUIEvents } from '@Shared/Events/NUIEvents.js';
import type { AccountSettings } from '@Shared/Constants/AccountSettings.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Settings bridge on the Frontend.
 *
 *   onNet SettingsPushed:
 *     Server echoed the post-merge snapshot after a SettingsUpdate.
 *     Forward to the SPA so its store mirrors the persisted state.
 *
 *   NUI callback Settings:Update:
 *     SPA fired a partial update; relay to the server. The server's
 *     echo (SettingsPushed) closes the loop.
 */
export class SettingsController {
  private readonly Log = Logger.New('Settings');

  constructor(private readonly Nui: NuiService) {
    onNet(
      NetEvents.SettingsPushed,
      (Payload: NetEventPayloads[typeof NetEvents.SettingsPushed]): void => {
        this.Nui.Send(NUIEvents.SettingsHydrate, { Settings: Payload.Settings });
      },
    );

    this.Nui.OnCallback<{ Settings: Partial<AccountSettings> }>(
      'Settings:Update',
      (Data): void => {
        const Settings = Data?.Settings;
        if (Settings === undefined || Settings === null) return;
        const Payload: NetEventPayloads[typeof NetEvents.SettingsUpdate] = { Settings };
        emitNet(NetEvents.SettingsUpdate, Payload);
      },
    );

    this.Log.Debug('Handlers registered (Settings:Update NUI, SettingsPushed net)');
  }
}
