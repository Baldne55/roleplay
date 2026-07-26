import { NetEvents } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { InjuryService } from '@/Services/InjuryService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Backend half of the injury detection wire. The Frontend
 * InjuryController polls own-ped HP at 250 ms and emits
 * `Roleplay:Net:Injury:HealthCritical` when the value crosses below the
 * critical threshold while in a Healthy state; this controller routes
 * that signal into InjuryService.AdvanceFromCriticalHit.
 *
 * The payload is empty by design - Source is the FXServer netId
 * (forge-proof) and the InjuryService reads coords + current status
 * authoritatively from server state. A malicious client spamming the
 * event can not advance state faster than the cascade cooldown allows,
 * and the Phase=Spawned gate here rejects events from anyone not in
 * the world.
 */
export class InjuryController {
  private readonly Log = Logger.New('InjuryController');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Injury: InjuryService,
  ) {
    onNet(NetEvents.InjuryHealthCritical, (): void => {
      const Src = source;
      if (this.State.Get(Src)?.Phase !== 'Spawned') return;
      void this.Injury.AdvanceFromCriticalHit(Src);
    });
    this.Log.Debug('Handlers registered (InjuryHealthCritical)');
  }
}
