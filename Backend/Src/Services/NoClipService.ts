import { Logger } from '@/Util/Logger.js';
import type { PositionValidatorService } from '@/Services/PositionValidatorService.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';

/**
 * Server-owned /noclip state. The on/off bit lives here (not in a
 * command closure) so the three places that must tear it down -
 * playerDropped, /changecharacter, /logout - share one authority and
 * the cheat-shaped side effects can never leak across a session.
 *
 * Each enable/disable keeps three things in lockstep:
 *   - the Active set (the source of truth for "is this Source flying"),
 *   - the PositionValidator suspend gate (boosted flight outruns the
 *     teleport threshold), and
 *   - the anti-cheat expected-state ledger + its replicated mirror (the
 *     client monitor reads the mirror to know its own invincibility /
 *     collision-off is sanctioned).
 *
 * Reset() clears all three without emitting the client toggle - the
 * session-return events already tear the client side down, so a Reset
 * during /changecharacter must not fight that.
 */
export class NoClipService {
  private readonly Log = Logger.New('NoClip');
  private readonly Active = new Set<number>();

  constructor(
    private readonly Validator: PositionValidatorService,
    private readonly Anticheat: AnticheatService,
  ) {}

  /**
   * Whether noclip is on for a Source.
   *
   * Read by the position validator, which must not flag a noclipping
   * admin for impossible movement.
   */
  IsActive(Source: number): boolean {
    return this.Active.has(Source);
  }

  /** Flip the flight state and return the resolved value. */
  Toggle(Source: number): boolean {
    const NowOn = !this.Active.has(Source);
    if (NowOn) this.Enable(Source);
    else this.Disable(Source);
    return NowOn;
  }

  /** Turn noclip on, suppressing movement validation for this Source. */
  private Enable(Source: number): void {
    this.Active.add(Source);
    this.Validator.Suspend(Source);
    this.Anticheat.SetExpected(Source, 'NoClip', true);
    this.Log.Debug(`Enabled source=${Source}`);
  }

  /**
   * Turn noclip off and re-seed the validator at the current position, so
   * the flight is not retroactively judged as one impossible jump.
   */
  private Disable(Source: number): void {
    this.Active.delete(Source);
    this.Validator.Resume(Source);
    this.Anticheat.SetExpected(Source, 'NoClip', false);
    this.Log.Debug(`Disabled source=${Source}`);
  }

  /**
   * Tear down noclip without touching the client (the session-return
   * events do that). Idempotent: safe on a Source that is not flying.
   * Called from the mid-session transitions so a noclip left on at
   * /changecharacter or /logout cannot persist into the next character.
   */
  Reset(Source: number): void {
    if (!this.Active.has(Source)) return;
    this.Active.delete(Source);
    this.Validator.Resume(Source);
    this.Anticheat.SetExpected(Source, 'NoClip', false);
    this.Log.Debug(`Reset source=${Source}`);
  }

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Drops only the flight bit: the validator
   * entry dies with CharacterController's persist detach and the
   * expected-state ledger entry dies with AnticheatService.Evict, so -
   * unlike Reset - no Resume / SetExpected runs against the gone client.
   */
  Evict(Source: number): void {
    this.Active.delete(Source);
  }
}
