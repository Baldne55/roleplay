import { Logger } from '@/Util/Logger.js';
import type { IQueueService } from '@/Infrastructure/Queue/IQueueService.js';
import { WrapDeferrals, type RawDeferrals } from '@/Infrastructure/Queue/Deferrals.js';

// FXServer sets `source` as a global before each event handler fires.
// Capture it on the first line of each handler before any awaits.
/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;

declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Connection lifecycle controller.
 *
 *   playerConnecting -> defer + hand off to QueueService
 *   playerJoining    -> clear in-flight (player is now counted by FXServer)
 *
 * Queue removal on disconnect lives in the PlayerSessionService
 * playerDropped dispatcher (Queue.Remove rejects a still-queued
 * connection's Admit promise).
 *
 * Trust boundary: nothing read from the client. `source` is set by the
 * runtime; identifiers (when we wire Discord later) come from the
 * server-side `GetPlayerIdentifiers(Source)` native, never from anything
 * the client claims about itself.
 */
export class ConnectionController {
  private readonly Log = Logger.New('Connection');

  constructor(Queue: IQueueService) {
    on('playerConnecting', (Name: string, _SetKickReason: (Reason: string) => void, RawDef: RawDeferrals): void => {
      const Source = source;
      const Wrapped = WrapDeferrals(RawDef);
      Queue.Admit(Source, Wrapped).catch((Err: unknown) => {
        this.Log.Warn(`Admit failed for ${Name} (source=${Source})`, { Err: String(Err) });
      });
    });

    on('playerJoining', (): void => {
      Queue.NotifyJoined();
    });

    this.Log.Debug('Handlers registered (playerConnecting, playerJoining)');
  }
}
