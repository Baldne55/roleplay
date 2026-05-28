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
export interface RawDeferrals {
  defer: () => void;
  update: (Message: string) => void;
  done: (Reason?: string) => void;
}

export function WrapDeferrals(Raw: RawDeferrals): Deferrals {
  return {
    Defer: () => Raw.defer(),
    Update: (Message: string) => Raw.update(Message),
    Done: (Reason?: string) => Raw.done(Reason),
  };
}
