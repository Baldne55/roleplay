import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { NUIEvents } from '@Shared/Events/NUIEvents.js';
import type { AppearanceData, Gender, PreviewCamera } from '@Shared/Constants/Character.js';
import type { OutfitData } from '@Shared/Constants/Outfit.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';
import type { CharacterCreatorService } from '@/Services/CharacterCreatorService.js';
import type { SpawnService } from '@/Services/SpawnService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Character lifecycle on the client side - create, list, select, spawn.
 *
 *   onNet  CharacterCreateSuccess  -> NUI CharacterCreated (UI form reset
 *                                     hook; actual spawn rides
 *                                     CharacterSpawned, fired by the
 *                                     server right after Create)
 *   onNet  CharacterCreateFailure  -> NUI CharacterCreateFailed
 *   onNet  CharacterListResponse   -> NUI CharacterListLoaded
 *   onNet  CharacterSpawned        -> NUI CharacterSpawning + Spawn.SpawnIntoWorld
 *   onNet  CharacterSelectFailure  -> NUI CharacterSelectFailed
 *
 *   NUI    CharacterPreviewStart   -> Creator.StartPreview(gender)
 *   NUI    CharacterPreviewApply   -> Creator.ApplyAppearance(data)
 *   NUI    CharacterPreviewOutfit  -> Creator.ApplyOutfit(data)
 *   NUI    CharacterPreviewCamera  -> Creator.ApplyCamera(spec)
 *   NUI    CharacterPreviewStop    -> Creator.StopPreview()
 *   NUI    CharacterCreate         -> emitNet CharacterCreate(payload)
 *   NUI    CharacterList           -> emitNet CharacterList
 *   NUI    CharacterSelect         -> emitNet CharacterSelect(payload)
 */
export class CharacterController {
  private readonly Log = Logger.New('Character');

  constructor(
    private readonly Creator: CharacterCreatorService,
    private readonly Spawn: SpawnService,
    private readonly Nui: NuiService,
  ) {
    onNet(
      NetEvents.CharacterCreateSuccess,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterCreateSuccess]): void => {
        this.Log.Debug(
          `CharacterCreateSuccess id=${Payload.CharacterID} name="${Payload.FirstName} ${Payload.LastName}"`,
        );
        this.Nui.Send(NUIEvents.CharacterCreated, {
          CharacterID: Payload.CharacterID,
          SlotID: Payload.SlotID,
          FirstName: Payload.FirstName,
          LastName: Payload.LastName,
        });
      },
    );

    onNet(
      NetEvents.CharacterCreateFailure,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterCreateFailure]): void => {
        this.Log.Warn(`CharacterCreateFailure: ${Payload.Reason}`);
        this.Nui.Send(NUIEvents.CharacterCreateFailed, { Reason: Payload.Reason });
      },
    );

    onNet(
      NetEvents.CharacterListResponse,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterListResponse]): void => {
        this.Log.Debug(`CharacterListResponse count=${Payload.Characters.length}`);
        this.Nui.Send(NUIEvents.CharacterListLoaded, { Characters: Payload.Characters });
      },
    );

    onNet(
      NetEvents.CharacterSpawned,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterSpawned]): void => {
        this.Log.Debug(`CharacterSpawned id=${Payload.CharacterID}`);
        this.Nui.Send(NUIEvents.CharacterSpawning, {});
        // Release NUI focus so the keyboard / mouse go back to the game.
        this.Nui.Focus(false, false);
        // Tear down the creator's scripted camera (no-op if not active)
        // BEFORE the spawn pipeline so its handle doesn't leak past the
        // SpawnService's RenderScriptCams(false) call.
        this.Creator.DismissForSpawn();
        void this.Spawn.SpawnIntoWorld(Payload).catch((Err: unknown) => {
          this.Log.Error('SpawnIntoWorld threw', { Err: String(Err) });
        });
      },
    );

    onNet(
      NetEvents.CharacterSelectFailure,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterSelectFailure]): void => {
        this.Log.Warn(`CharacterSelectFailure: ${Payload.Reason}`);
        this.Nui.Send(NUIEvents.CharacterSelectFailed, { Reason: Payload.Reason });
      },
    );

    this.Nui.OnCallback<{ Gender: Gender }>('CharacterPreviewStart', async (Data): Promise<void> => {
      await this.Creator.StartPreview(Data.Gender);
    });

    this.Nui.OnCallback<{ Appearance: AppearanceData }>('CharacterPreviewApply', (Data): void => {
      this.Creator.ApplyAppearance(Data.Appearance);
    });

    this.Nui.OnCallback<{ Outfit: OutfitData }>('CharacterPreviewOutfit', (Data): void => {
      this.Creator.ApplyOutfit(Data.Outfit);
    });

    this.Nui.OnCallback<{ Camera: PreviewCamera }>('CharacterPreviewCamera', (Data): void => {
      this.Creator.ApplyCamera(Data.Camera);
    });

    this.Nui.OnCallback('CharacterPreviewStop', (): void => {
      this.Creator.StopPreview();
    });

    this.Nui.OnCallback<NetEventPayloads[typeof NetEvents.CharacterCreate]>(
      'CharacterCreate',
      (Data): void => {
        this.Log.Debug(`UI requested CharacterCreate name="${Data.FirstName} ${Data.LastName}"`);
        emitNet(NetEvents.CharacterCreate, Data);
      },
    );

    this.Nui.OnCallback('CharacterList', (): void => {
      this.Log.Debug('UI requested CharacterList');
      emitNet(NetEvents.CharacterList);
    });

    this.Nui.OnCallback<NetEventPayloads[typeof NetEvents.CharacterSelect]>(
      'CharacterSelect',
      (Data): void => {
        this.Log.Debug(`UI requested CharacterSelect id=${Data.CharacterID}`);
        emitNet(NetEvents.CharacterSelect, Data);
      },
    );

    this.Log.Debug(
      'Handlers registered (Net: CreateSuccess/Failure, ListResponse, Spawned, SelectFailure; ' +
        'NUI: PreviewStart/Apply/Outfit/Camera/Stop, Create, List, Select)',
    );
  }
}
