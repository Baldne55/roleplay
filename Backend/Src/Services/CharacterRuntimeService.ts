import type { BleedingStatus, InjuryStatus } from '@Shared/Constants/Character.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
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
  /**
   * Character's legal first/last name as written on the row. Lives on the
   * runtime so chat broadcasters can resolve a Source -> display name in
   * one map lookup; reading the DB on every /me or /say would be wasteful.
   */
  FirstName: string;
  LastName: string;
  /**
   * 4-digit forensic mask ID stamped at creation. When IsMasked is true the
   * chat broadcaster renders the character as `Stranger <MaskID>` instead
   * of the legal name - the canonical anti-metagame display path.
   */
  MaskID: string;
  IsMasked: boolean;
  /**
   * BirthDate carried verbatim from the row (DATEONLY YYYY-MM-DD). Lets
   * the runtime derive IsMinor once at attach time without re-hitting
   * the DB later in the session. Birthdays don't move during a session.
   */
  BirthDate: string;
  IsMinor: boolean;
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
 *
 * Beyond the legacy `Roleplay:IsMasked` / injury bag keys, Attach now
 * also publishes the per-player identity surface the nametag overlay
 * reads every frame: CharacterID (render gate), DisplayName (mask-aware
 * legal-name swap), IsMinor (RP `[M]` flag). Detach nulls them so a
 * mid-session /changecharacter doesn't leave stale tags on the player.
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
    this.WriteStateBag(Source, NametagBagKeys.IsMasked, Runtime.IsMasked);
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, Runtime.InjuryStatus);
    this.WriteStateBag(Source, 'Roleplay:BleedingStatus', Runtime.BleedingStatus);
    // Nametag identity surface. CharacterID gates the renderer (null =
    // auth shell / selector; skip ped). DisplayName is the mask-aware
    // result of ResolveDisplayName below - the client never sees the
    // legal name when IsMasked=true.
    this.WriteStateBag(Source, NametagBagKeys.CharacterID, Runtime.CharacterID);
    this.WriteStateBag(Source, NametagBagKeys.DisplayName, ResolveDisplayName(Runtime));
    this.WriteStateBag(Source, NametagBagKeys.IsMinor, Runtime.IsMinor);
    this.Log.Debug(
      `Attached source=${Source} character=${Runtime.CharacterID} minor=${Runtime.IsMinor}`,
    );
  }

  Get(Source: number): CharacterRuntime | null {
    return this.Cache.get(Source) ?? null;
  }

  /**
   * Atomic "fetch + remove" - returns the runtime if one was tracked
   * and clears the entry in the same call. Used by the disconnect
   * handler so the in-memory state is gone before the async DB write
   * resolves (no risk of a late save racing against a reconnect).
   *
   * Also wipes every nametag-related bag key so a mid-session exit
   * (/changecharacter, /logout) doesn't leave stale identity on the
   * player. AdminDuty / typing / damage-flash keys are cleared too even
   * though their writers live elsewhere - the runtime is the single
   * choke for "this player is not spawned anymore".
   */
  Detach(Source: number): CharacterRuntime | null {
    const Runtime = this.Cache.get(Source) ?? null;
    if (Runtime !== null) {
      this.Cache.delete(Source);
      this.ClearNametagBag(Source);
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
    this.WriteStateBag(Source, NametagBagKeys.IsMasked, IsMasked);
    // Display name flips when the mask goes on/off. Re-publish so the
    // nametag overlay (and any future scoreboard) never lags the
    // canonical anti-metagame chokepoint.
    this.WriteStateBag(Source, NametagBagKeys.DisplayName, ResolveDisplayName(Runtime));
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
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, Status);
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

  /**
   * Null every nametag-related bag key. Called from Detach so a mid-
   * session exit (/changecharacter, /logout) leaves no stale identity
   * data hanging on the Source for the next character to inherit.
   */
  private ClearNametagBag(Source: number): void {
    this.WriteStateBag(Source, NametagBagKeys.CharacterID, null);
    this.WriteStateBag(Source, NametagBagKeys.DisplayName, null);
    this.WriteStateBag(Source, NametagBagKeys.IsMinor, false);
    this.WriteStateBag(Source, NametagBagKeys.IsMasked, false);
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, 'Healthy');
    this.WriteStateBag(Source, NametagBagKeys.Action, null);
    this.WriteStateBag(Source, NametagBagKeys.AdminDuty, false);
    this.WriteStateBag(Source, NametagBagKeys.AdminDutyLabel, '');
    this.WriteStateBag(Source, NametagBagKeys.AdminDutyName, '');
  }
}

/**
 * Anti-metagame chokepoint for the published name. When masked, the
 * client sees `Stranger <MaskID>` - the same in-fiction framing the
 * chat broadcaster uses. The legal name never leaves the server until
 * the mask comes off.
 */
function ResolveDisplayName(Runtime: CharacterRuntime): string {
  if (Runtime.IsMasked) return `Stranger ${Runtime.MaskID}`;
  return `${Runtime.FirstName} ${Runtime.LastName}`;
}
