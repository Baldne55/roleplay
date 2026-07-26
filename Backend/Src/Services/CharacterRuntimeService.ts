import type { BleedingStatus, InjuryStatus } from '@Shared/Constants/Character.js';
import type { RadioState } from '@Shared/Constants/Radio.js';
import { BleedingStatusBagKey } from '@Shared/Constants/Bleeding.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function Player(Source: number | string): {
  state: {
    set: (Key: string, Value: unknown, Replicated: boolean) => void;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * In-memory snapshot of the mutable per-session character state that
 * the server tracks authoritatively (i.e. fields the client can't be
 * trusted to report). Position / heading / HP / AP are NOT in here -
 * those are read live via FiveM natives at save time, since the engine
 * is the source of truth for entity state.
 *
 *   - IsMasked       - toggled by a future /mask command.
 *   - Bank           - written by the bank slice when it ships; the
 *                      in-memory copy mirrors the DB so the disconnect
 *                      save can flush it without an extra read.
 *   - InjuryStatus / BleedingStatus - flipped by the combat / injury
 *                      systems when they ship.
 *
 * Cash left the runtime cache in 0.5.0 - paper currency is an
 * inventory item now and `CashService.GetTotalCents` walks the rows
 * on every read. Bank stays as a string to match the model's
 * DECIMAL(12,2) column shape (mysql2 round-trips DECIMAL as string;
 * arithmetic on a JS number would silently lose precision past ~$10M).
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
  /**
   * Blood type carried verbatim from the row (server-private, never
   * replicated through a state bag). The bleeding layer stamps it into
   * blood-splat evidence metadata so forensic examination of a splat
   * can narrow the bleeder without ever exposing the legal name.
   */
  BloodType: string;
  Bank: string;
  InjuryStatus: InjuryStatus;
  BleedingStatus: BleedingStatus;
  /**
   * Handheld-radio tuning (power + channels). Server-private - never
   * replicated to a state bag, like Bank - and flushed to the
   * radio_state column on disconnect. Mutated in place by RadioService
   * through SetRadioState.
   */
  RadioState: RadioState;
  /**
   * Serial (= phone number) of the handset the player has set as active
   * for /phone commands when carrying several, or null. Server-private,
   * like Bank/RadioState. Persisted eagerly to active_phone_serial on the
   * /phone main mutation (not relied on for the disconnect flush). Always
   * re-validated against currently-held phones before use, so a stale
   * pointer to a traded/dropped handset can never spoof the origin number.
   */
  ActivePhoneSerial: string | null;
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

  /**
   * Bind a spawned character's runtime to a Source and publish its
   * public-facing fields to state bags.
   *
   * The mirror image of Detach - anything replicated here must be cleared
   * there, or a character switch leaves the previous identity on the
   * player. See the inline notes on what is deliberately NOT replicated.
   */
  Attach(Source: number, Runtime: CharacterRuntime): void {
    this.Cache.set(Source, Runtime);
    // Replicate the public-facing flags via OneSync state bags so other
    // resources (and our own client) can read but not mutate. Cash /
    // Bank are deliberately omitted - balances are server-private to
    // prevent griefing surfaces ("where's the rich guy" radar).
    this.WriteStateBag(Source, NametagBagKeys.IsMasked, Runtime.IsMasked);
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, Runtime.InjuryStatus);
    this.WriteStateBag(Source, BleedingStatusBagKey, Runtime.BleedingStatus);
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

  /**
   * The runtime for a Source, or null when not spawned. Null is the
   * normal state during auth and character selection, not an error.
   */
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

  /**
   * Toggle the mask. Re-publishes DisplayName as well as the flag, since
   * masking changes the character's rendered name to `Stranger <MaskID>` -
   * updating one without the other would leak the legal name.
   */
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

  /**
   * Update the cached bank balance. Server-private - never replicated, so
   * no state bag advertises who is worth robbing. String-typed to match
   * the DECIMAL column and avoid float drift.
   */
  SetBank(Source: number, Bank: string): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.Bank = Bank;
    // Bank deliberately NOT in state bags (server-private).
  }

  /**
   * Update radio tuning. Server-private like Bank - a client that could
   * read others' channels would defeat the point of a radio.
   */
  SetRadioState(Source: number, State: RadioState): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.RadioState = State;
    // Radio state is server-private, like Bank - no state bag write.
  }

  /**
   * Set which carried handset `/phone` commands act on. Server-private;
   * also persisted eagerly so the choice survives a disconnect that skips
   * the position-bearing save.
   */
  SetActivePhoneSerial(Source: number, Serial: string | null): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.ActivePhoneSerial = Serial;
    // Server-private, like Bank/RadioState - no state bag write.
  }

  /**
   * Set the injury tier and replicate it - the client movement layer
   * reads this bag to gate what an incapacitated player can do.
   */
  SetInjuryStatus(Source: number, Status: InjuryStatus): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.InjuryStatus = Status;
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, Status);
  }

  /**
   * Set the bleeding tier and replicate it, for the same reason as
   * SetInjuryStatus - the client reads it to drive stumbles and effects.
   */
  SetBleedingStatus(Source: number, Status: BleedingStatus): void {
    const Runtime = this.Cache.get(Source);
    if (Runtime === undefined) return;
    Runtime.BleedingStatus = Status;
    this.WriteStateBag(Source, BleedingStatusBagKey, Status);
  }

  /**
   * Stamp the replicated damage-flash bag. Written server-side from
   * the Backend's weaponDamageEvent hook - the client no longer
   * writes its own bag, so a modified client can neither fake nor
   * suppress the red flash other players see. No-ops for sources
   * without an attached runtime (auth-shell peds take no RP damage).
   */
  PublishDamageFlash(Source: number): void {
    if (!this.Cache.has(Source)) return;
    this.WriteStateBag(Source, NametagBagKeys.DamageFlash, Date.now());
  }

  /**
   * Replicate the chat typing indicator. Written server-side from the
   * Backend ChatController's ChatTypingState handler (the client emits a
   * focus on/off event instead of writing its own bag) so the
   * `Roleplay:` bag namespace stays entirely server-owned - the
   * anti-cheat tamper watch then flags any client write to a `Roleplay:`
   * key without a legitimate exception. No-ops for sources without an
   * attached runtime.
   */
  SetTyping(Source: number, On: boolean): void {
    if (!this.Cache.has(Source)) return;
    this.WriteStateBag(Source, NametagBagKeys.IsTyping, On);
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
   * Null every nametag-related bag key and reset the replicated
   * bleeding bag. Called from Detach so a mid-session exit
   * (/changecharacter, /logout) leaves no stale identity or wound data
   * hanging on the Source for the next character to inherit.
   */
  private ClearNametagBag(Source: number): void {
    this.WriteStateBag(Source, NametagBagKeys.CharacterID, null);
    this.WriteStateBag(Source, NametagBagKeys.DisplayName, null);
    this.WriteStateBag(Source, NametagBagKeys.IsMinor, false);
    this.WriteStateBag(Source, NametagBagKeys.IsMasked, false);
    this.WriteStateBag(Source, NametagBagKeys.InjuryStatus, 'Healthy');
    this.WriteStateBag(Source, BleedingStatusBagKey, 'NotBleeding');
    this.WriteStateBag(Source, NametagBagKeys.IsTyping, false);
    this.WriteStateBag(Source, NametagBagKeys.Action, null);
    this.WriteStateBag(Source, NametagBagKeys.AdminDuty, false);
    this.WriteStateBag(Source, NametagBagKeys.AdminDutyLabel, '');
    this.WriteStateBag(Source, NametagBagKeys.AdminDutyName, '');
    // The equipped-weapon bag is NOT cleared here - decision 21 moved
    // to InventoryService.ClearEquippedWeapon, which the detach caller
    // (CharacterController.PersistAndDetachRuntime) invokes before
    // Detach so the bag-null and the server-side weapon strip travel
    // together.
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
