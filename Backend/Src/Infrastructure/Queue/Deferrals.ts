/**
 * Ambient type for the FXServer `deferrals` object passed to `playerConnecting`
 * handlers. The @citizenfx/server typings don't expose this shape directly,
 * so we declare what we actually use.
 *
 * Reference: https://docs.fivem.net/docs/scripting-manual/working-with-events/listening-for-events/#server-side
 */
export interface Deferrals {
  /** Start deferring. Must be called before any update/done. */
  Defer(): void;
  /** Update the status message shown to the connecting player. */
  Update(Message: string): void;
  /**
   * Finalise the deferral. Calling with no argument admits the player;
   * calling with a string rejects them with that reason.
   */
  Done(Reason?: string): void;
}

/**
 * FXServer hands us a deferrals object with camelCase methods (defer/update/
 * done). Wrap it so internal callers can use our PascalCase API without
 * touching the raw camelCase surface anywhere else.
 */
/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
/**
 * The deferral object FXServer hands to a `playerConnecting` handler,
 * with its original lowercase native names.
 *
 * `defer()` must be called before any await, or the connection proceeds
 * without waiting; `done()` with a reason rejects the player, without one
 * admits them.
 */
export interface RawDeferrals {
  defer: () => void;
  update: (Message: string) => void;
  done: (Reason?: string) => void;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Adapt the engine's lowercase deferral object to the house PascalCase
 * interface, so the rest of the codebase never touches the raw native
 * shape and the connection flow stays unit-testable behind a fake.
 */
export function WrapDeferrals(Raw: RawDeferrals): Deferrals {
  return {
    Defer: () => Raw.defer(),
    Update: (Message: string) => Raw.update(Message),
    Done: (Reason?: string) => Raw.done(Reason),
  };
}
