import type { BleedingStatus, InjuryStatus } from '@Shared/Constants/Character.js';
import { Logger } from '@/Util/Logger.js';

declare function Player(Source: number | string): {
  state: {
    set: (Key: string, Value: unknown, Replicated: boolean) => void;
  };
};

/**
 * In-memory snapshot of the mutable per-session character state that
 * the server tracks authoritatively (i.e. fields the client can't be
 * trusted to report). Position / heading / HP / AP are NOT in here -
 * those are read live via FiveM natives at save time, since the engine
 * is the source of truth for entity state.
 *
 *   - IsMasked       - toggled by a future /mask command.
 *   - Cash / Bank    - written by the economy / transaction layer when
 *                      it ships; the in-memory copy mirrors the DB so
 *                      the disconnect save can flush it without an
 *                      extra read.
 *   - InjuryStatus / BleedingStatus - flipped by the combat / injury
 *                      systems when they ship.
 *
 * Cash and Bank are kept as strings to match the model's DECIMAL(12,2)
 * column shape (mysql2 round-trips DECIMAL as string; arithmetic on a
 * JS number would silently lose precision past ~$10M).
 */
export interface CharacterRuntime {
  CharacterID: string;
  IsMasked: boolean;
  Cash: string;
  Bank: string;
  InjuryStatus: InjuryStatus;
  BleedingStatus: BleedingStatus;
}

/**
 * Per-source character runtime cache. Lifetime is "character spawned
 * until playerDropped (or character switch when that lands)". Attached
 * by the spawn pathway, drained + persisted on disconnect.
 *
 * Keyed by Source - the player's FXServer netId, the same key every
 * other per-connection service uses. A character switch (future) will
 * Detach the current runtime, persist, then Attach the next one in
 * place.
 */
export class CharacterRuntimeService {
  private readonly Log = Logger.New('CharacterRuntime');
  private readonly Cache = new Map<number, CharacterRuntime>();

  Attach(Source: number, Runtime: CharacterRuntime): void {
    this.Cache.set(Source, Runtime);
    // Replicate the public-facing flags via OneSync state bags so other
    // resources (and our own client) can read but not mutate. Cash /
    // Bank are deliberately omitted - balances are server-private to
    // prevent griefing surfaces ("where's the rich guy" radar).
    this.WriteStateBag(Source, 'Roleplay:IsMasked', Runtime.IsMasked);
    this.WriteStateBag(Source, 'Roleplay:InjuryStatus', Runtime.InjuryStatus);
    this.WriteStateBag(Source, 'Roleplay:BleedingStatus', Runtime.BleedingStatus);
    this.Log.Debug(`Attached source=${Source} character=${Runtime.CharacterID}`);
  }

  Get(Source: number): CharacterRuntime | null {
    return this.Cache.get(Source) ?? null;
  }

  /**
   * Atomic "fetch + remove" - returns the runtime if one was tracked
   * and clears the entry in the same call. Used by the disconnect
   * handler so the in-memory state is gone before the async DB write
   * resolves (no risk of a late save racing against a reconnect).
   */
  Detach(Source: number): CharacterRuntime | null {
    const Runtime = this.Cache.get(Source) ?? null;
    if (Runtime !== null) {
      this.Cache.delete(Source);
      this.Log.Debug(`Detached source=${Source} character=${Runtime.CharacterID}`);
    }
    return Runtime;
  }

  // ── Mutators for future systems ─────────────────────────────────────
  // These exist so the call-site doesn't have to read-modify-write the
  // whole runtime blob; each one no-ops when the source isn't tracked
  // (i.e. the player isn't spawned yet).

  SetIsMasked(Source: number, IsMasked: boolean): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.IsMasked = IsMasked;
    this.WriteStateBag(Source, 'Roleplay:IsMasked', IsMasked);
  }

  SetCash(Source: number, Cash: string): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.Cash = Cash;
    // Cash deliberately NOT in state bags (server-private).
  }

  SetBank(Source: number, Bank: string): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.Bank = Bank;
    // Bank deliberately NOT in state bags (server-private).
  }

  SetInjuryStatus(Source: number, Status: InjuryStatus): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.InjuryStatus = Status;
    this.WriteStateBag(Source, 'Roleplay:InjuryStatus', Status);
  }

  SetBleedingStatus(Source: number, Status: BleedingStatus): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.BleedingStatus = Status;
    this.WriteStateBag(Source, 'Roleplay:BleedingStatus', Status);
  }

  /**
   * OneSync state bag write. The third arg = true replicates the value
   * to every client. Reads on the client side: Player(src).state.<key>
   * or LocalPlayer.state.<key>. The key namespace `Roleplay:*` keeps us
   * clear of any third-party resource conventions.
   */
  private WriteStateBag(Source: number, Key: string, Value: unknown): void {
    try {
      Player(Source).state.set(Key, Value, true);
    } catch (Err: unknown) {
      this.Log.Warn(`State bag write failed - source=${Source} key=${Key}`, {
        Err: String(Err),
      });
    }
  }
}
