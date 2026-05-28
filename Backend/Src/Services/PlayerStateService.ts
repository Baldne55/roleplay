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

  Initialise(Source: number, Bucket: number): PlayerState {
    const State: PlayerState = {
      Source,
      Phase: 'PreAuth',
      Bucket,
      AccountID: null,
      CharacterID: null,
      ConnectedAt: Date.now(),
    };
    this.States.set(Source, State);
    this.Log.Info(`State initialised - source=${Source} phase=PreAuth bucket=${Bucket}`);
    return State;
  }

  Get(Source: number): PlayerState | null {
    return this.States.get(Source) ?? null;
  }

  SetPhase(Source: number, Phase: PlayerPhase): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.Phase = Phase;
    this.Log.Info(`Phase -> ${Phase} - source=${Source}`);
  }

  SetAccountID(Source: number, AccountID: string): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.AccountID = AccountID;
    this.Log.Info(`AccountID -> ${AccountID} - source=${Source}`);
  }

  SetCharacterID(Source: number, CharacterID: string): void {
    const State = this.States.get(Source);
    if (State === undefined) return;
    State.CharacterID = CharacterID;
    this.Log.Info(`CharacterID -> ${CharacterID} - source=${Source}`);
  }

  Clear(Source: number): PlayerState | null {
    const State = this.States.get(Source) ?? null;
    if (State !== null) {
      this.States.delete(Source);
      this.Log.Info(`State cleared - source=${Source}`);
    }
    return State;
  }
}
