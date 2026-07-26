import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { Logger } from '@/Util/Logger.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
/* eslint-enable @typescript-eslint/naming-convention */

/** How long a floated action line lingers above the head. */
const ClearAfterMs = 5_000;

/**
 * The floating action line above a character's nametag - the /ame
 * channel. Originally owned by NametagActionCommands; extracted to a
 * service when item interactions moved onto it (decision 2026-06-12:
 * using, drinking, giving, examining, and breath tests float above
 * the head instead of broadcasting `/me` lines, keeping the chat box
 * for conversation).
 *
 * One write per action: the formatted string lands in the replicated
 * `Roleplay:NametagAction` state bag, the NametagController overlay
 * renders it for everyone in nametag range, and a 5 s timer clears
 * the bag back to null. Back-to-back actions reset the timeout, so
 * the newest line always gets its full hang time.
 */
export class NametagActionService {
  private readonly Log = Logger.New('NametagAction');
  /** Source -> pending clear timer. */
  private readonly Timers = new Map<number, NodeJS.Timeout>();

  constructor(private readonly Broadcaster: ProximityBroadcaster) {}

  /** Float `* Name <body>` above the head (the plain /ame shape). */
  SetAction(Source: number, Body: string): void {
    const DisplayName = this.Broadcaster.DisplayName(Source) ?? 'Someone';
    this.SetFormatted(Source, `* ${DisplayName} ${Body}`);
  }

  /** Float a pre-formatted line verbatim (the /amy possessive shape). */
  SetFormatted(Source: number, Formatted: string): void {
    this.WriteBag(Source, Formatted);
    this.ResetTimer(Source);
  }

  /**
   * playerDropped cleanup - clearing the timer prevents a late fire
   * from touching a state bag for a Source the engine has already
   * recycled.
   */
  OnPlayerDropped(Source: number): void {
    const Timer = this.Timers.get(Source);
    if (Timer !== undefined) {
      clearTimeout(Timer);
      this.Timers.delete(Source);
    }
  }

  /**
   * Replicated state-bag write under `Roleplay:NametagAction`. Wrapped
   * so a native exception (Source already gone, OneSync hiccup) is
   * logged rather than thrown into the caller.
   */
  private WriteBag(Source: number, Value: string | null): void {
    try {
      Player(Source).state.set(NametagBagKeys.Action, Value, true);
    } catch (Err: unknown) {
      this.Log.Warn(`State bag write failed - source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * Replace any existing clear-timer for this Source with a fresh 5 s
   * countdown, so back-to-back actions extend the window rather than
   * letting the first timer prematurely null the second line.
   */
  private ResetTimer(Source: number): void {
    const Existing = this.Timers.get(Source);
    if (Existing !== undefined) clearTimeout(Existing);

    const Timer = setTimeout(() => {
      this.Timers.delete(Source);
      this.WriteBag(Source, null);
    }, ClearAfterMs);

    this.Timers.set(Source, Timer);
  }
}
