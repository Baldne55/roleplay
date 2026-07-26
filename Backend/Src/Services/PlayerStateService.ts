import { Logger } from '@/Util/Logger.js';

/**
 * Coarse-grained player lifecycle phase. Drives which events / commands /
 * UI views are valid at any given moment. Per-feature state (current
 * Character, active job, etc.) lives in its own service - this is the
 * thin "where in the flow is this player" tracker.
 */
export type PlayerPhase =
  | 'PreAuth' // skybox shell, no account / no character yet
  | 'Authenticated' // account resolved, character-select shown
  | 'Spawned'; // character placed in the world

/**
 * Everything the server knows about a connection independent of which
 * character is loaded. Lives for the connection, not the character: a
 * /changecharacter clears CharacterID and drops Phase back to
 * Authenticated but keeps the same PlayerState object and AccountID.
 *
 * Mutated in place by the controllers rather than replaced, so a
 * reference held across an await still sees current values - which also
 * means a caller must never cache a FIELD off it across an await.
 */
export interface PlayerState {
  Source: number;
  Phase: PlayerPhase;
  Bucket: number;
  /** Account row id; string because BIGINT UNSIGNED is returned as string by mysql2. */
  AccountID: string | null;
  /**
   * Active character row id once Phase=Spawned. Stays null through the
   * PreAuth + Authenticated phases. SaveRuntime on playerDropped reads
   * this to know which row to persist.
   */
  CharacterID: string | null;
  /**
   * Session-only admin-on-duty flag. Toggled via a future /aduty command.
   * Required by the command dispatcher to gate staff-only commands so
   * staff can play IC characters without their admin shortcuts firing
   * (lc-rp parity). Never persisted - resets to false on every connect.
   */
  AdminDuty: boolean;
  ConnectedAt: number;
}

/**
 * In-memory player-state store, keyed by Source. Lifetime is per-connection -
 * entries are inserted on playerJoining and dropped on playerDropped.
 *
 * No persistence here; that's the Account / Character repositories.
 */
export class PlayerStateService {
  private readonly Log = Logger.New('PlayerState');
  private readonly States = new Map<number, PlayerState>();

  /**
   * Create the tracking entry for a connecting player, in the PreAuth
   * phase with their assigned routing bucket. Every later lookup depends
   * on this having run.
   */
  Initialise(Source: number, Bucket: number): PlayerState {
    const State: PlayerState = {
      Source,
      Phase: 'PreAuth',
      Bucket,
      AccountID: null,
      CharacterID: null,
      AdminDuty: false,
      ConnectedAt: Date.now(),
    };
    this.States.set(Source, State);
    this.Log.Debug(`State initialised - source=${Source} phase=PreAuth bucket=${Bucket}`);
    return State;
  }

  /**
   * State for a Source, or null if untracked (never connected, or already
   * cleared). Callers generally check `Phase === 'Spawned'` too - being
   * tracked is not the same as being in the world.
   */
  Get(Source: number): PlayerState | null {
    return this.States.get(Source) ?? null;
  }

  /**
   * Iterate every tracked Source. The PlayerStateService is the
   * source of truth for "who is currently connected" - entries are
   * inserted on playerJoining and dropped on playerDropped. Use this
   * instead of FXServer's `GetPlayers()` bare-global native, which
   * is unreliable across runtime bundling configurations and has
   * already cost us two production incidents on the chat broadcaster.
   */
  GetAllSources(): number[] {
    return Array.from(this.States.keys());
  }

  /**
   * Iterate only the Sources currently in the Spawned phase. Used
   * by chat broadcasts so an in-flight connection (PreAuth or
   * Authenticated) never receives an IC line through the skybox.
   */
  GetSpawnedSources(): number[] {
    const Out: number[] = [];
    for (const [Source, State] of this.States.entries()) {
      if (State.Phase === 'Spawned') Out.push(Source);
    }
    return Out;
  }

  /**
   * Advance the connection phase (PreAuth -> Authenticated -> Spawned).
   * The gate most command and broadcast paths test against.
   */
  SetPhase(Source: number, Phase: PlayerPhase): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.Phase = Phase;
    this.Log.Debug(`Phase -> ${Phase} - source=${Source}`);
  }

  /** Record the resolved account once identity is established. */
  SetAccountID(Source: number, AccountID: string): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.AccountID = AccountID;
    this.Log.Debug(`AccountID -> ${AccountID} - source=${Source}`);
  }

  /** Record the selected character on spawn. Cleared on a character switch. */
  SetCharacterID(Source: number, CharacterID: string): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.CharacterID = CharacterID;
    this.Log.Debug(`CharacterID -> ${CharacterID} - source=${Source}`);
  }

  /**
   * Drop the active character link without tearing down the player-state
   * entry. Used by mid-session transitions (e.g. /changecharacter, /logout)
   * that put the player back into a pre-spawn phase while the connection
   * itself stays open.
   */
  ClearCharacterID(Source: number): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.CharacterID = null;
    this.Log.Debug(`CharacterID cleared - source=${Source}`);
  }

  /**
   * Toggle admin duty. Separate from staff level: level is what a player
   * *may* do, duty is whether they are currently acting on it, and
   * staff-gated commands require both.
   */
  SetAdminDuty(Source: number, On: boolean): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.AdminDuty = On;
    this.Log.Debug(`AdminDuty -> ${On} - source=${Source}`);
  }

  /**
   * Remove tracking on disconnect, returning the final state for the
   * teardown path to act on. Fetch-and-remove in one call, so a
   * reconnecting player reusing the Source id cannot see stale state.
   */
  Clear(Source: number): PlayerState | null {
    const State = this.States.get(Source) ?? null;
    if (State !== null) {
      this.States.delete(Source);
      this.Log.Debug(`State cleared - source=${Source}`);
    }
    return State;
  }
}
