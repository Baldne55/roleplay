import { NUIEvents, type NUIEventName, type NUIEventPayloads } from '@Shared/Events/NUIEvents.js';
import { Logger } from '@/Util/Logger.js';

declare function RegisterNuiCallback(
  Name: string,
  Callback: (Data: unknown, Cb: (Response: unknown) => void) => void,
): void;

/**
 * Thin wrapper around the FiveM NUI bridge. Three concerns:
 *
 *   1. Sending typed messages to the SPA (SendNUIMessage forces us to
 *      stringify-safe payloads; the typed helper keeps the wire shape
 *      honest against NUIEventPayloads).
 *   2. Focus state. SetNuiFocus(focus, cursor) is how we tell FiveM to
 *      route input to CEF vs the game. Without `focus=true` the player
 *      cannot click anything in our card.
 *   3. UI-ready handshake. The SPA's bundle is ~250KB; CEF can take a
 *      second or two to download + mount it. Calls to SendNUIMessage
 *      before the SPA's window.message listener is wired up are silently
 *      dropped by FiveM (no native queueing). To race-proof this we hold
 *      a Ready flag plus a pending queue; the UI POSTs NuiReady when its
 *      inbox is live and we drain the queue.
 *
 *   Also: a NUI callback registration helper that subscribes to NUI->
 *   Frontend fetches from the SPA (e.g. "the user clicked Sign In").
 */
export class NuiService {
  private readonly Log = Logger.New('Nui');

  private IsReady = false;
  private readonly Pending: Array<() => void> = [];

  constructor() {
    RegisterNuiCallback('NuiReady', (_Data, Cb) => {
      this.IsReady = true;
      const Count = this.Pending.length;
      this.Log.Info(`UI ready (draining ${Count} pending op${Count === 1 ? '' : 's'})`);
      while (this.Pending.length > 0) {
        const Op = this.Pending.shift();
        if (Op !== undefined) Op();
      }
      Cb({});
    });
  }

  Send<Event extends NUIEventName>(EventName: Event, Payload: Omit<NUIEventPayloads[Event], 'Type'>): void {
    this.WhenReady(() => {
      const Full = { Type: EventName, ...Payload } as NUIEventPayloads[Event];
      SendNUIMessage(Full);
    });
  }

  Focus(WantFocus: boolean, WantCursor: boolean = WantFocus): void {
    // Focus is independent of CEF readiness - SetNuiFocus is a server-side
    // game state flag, not an NUI message. Apply immediately.
    SetNuiFocus(WantFocus, WantCursor);
  }

  /**
   * Register a NUI callback. The SPA reaches this via:
   *   fetch('https://roleplay/<Name>', { method: 'POST', body: '{...}' })
   *
   * The callback is invoked with the JSON-parsed body and a response
   * function. Always call the response function (with `{}` if no payload)
   * so the SPA's fetch promise resolves.
   */
  OnCallback<T>(Name: string, Handler: (Data: T) => Promise<unknown> | unknown): void {
    RegisterNuiCallback(Name, (Data, Cb) => {
      Promise.resolve()
        .then(() => Handler(Data as T))
        .then((Result) => Cb(Result ?? {}))
        .catch((Err: unknown) => {
          this.Log.Error(`NUI callback ${Name} threw`, { Err: String(Err) });
          Cb({ Ok: false, Error: String(Err) });
        });
    });
  }

  /** Run an operation now if the UI is ready, otherwise defer to when it is. */
  private WhenReady(Op: () => void): void {
    if (this.IsReady) {
      Op();
      return;
    }
    this.Pending.push(Op);
  }

  /** Convenience: focus first (some CEF builds reset NUI on focus change), then send. */
  ShowAuth(): void {
    this.Focus(true);
    this.Send(NUIEvents.AuthShow, {});
  }
}
