import { StunWeaponHashes } from '@Shared/Constants/Anticheat.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';
import type { InventoryService } from '@/Services/InventoryService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function CancelEvent(): void;
declare function GetEntityPopulationType(Handle: number): number;
declare function GetEntityModel(Entity: number): number;
declare function GetEntityType(Entity: number): number;
declare function NetworkGetEntityOwner(Entity: number): number;

/*
 * ── Net game-event payload shapes ────────────────────────────────────
 *
 * These mirror the CitizenFX game-event structures, so the field names
 * are camelCase engine names rather than house PascalCase - hence the
 * eslint suppression above.
 *
 * EVERY field is optional, on purpose. The payload is attacker-controlled:
 * only the *sender attribution* is trustworthy (FXServer supplies it),
 * while the body is whatever the client chose to put on the wire, up to
 * and including omitting fields entirely or sending wrong types. These
 * interfaces describe the shape of a well-formed packet, not a guarantee;
 * every handler typeof-checks each field before using it. Treat an
 * optional here as "the attacker may simply not send this."
 */

/** `explosionEvent` - the entity, kind and place of a detonation. */
interface ExplosionEventData {
  explosionType?: number;
  damageScale?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  isInvisible?: boolean;
  ownerNetId?: number;
}

/** `startProjectileEvent` - a thrown or launched projectile being created. */
interface StartProjectileEventData {
  ownerId?: number;
  projectileHash?: number;
  weaponHash?: number;
  firePositionX?: number;
  firePositionY?: number;
  firePositionZ?: number;
}

/**
 * `fireEvent` - ignition. The `fires` payload is an opaque array whose
 * shape varies by build, so it stays `unknown`: only its presence and
 * length are used, for rate-limiting fire spam.
 */
interface FireEventData {
  fires?: unknown;
}

/**
 * `giveWeaponEvent` - a client claiming a ped was handed a weapon.
 *
 * Never legitimate from a player here: weapons come from the inventory
 * service, so this event arriving at all is the detection.
 */
interface GiveWeaponEventData {
  pedId?: number;
  weaponType?: number;
  ammo?: number;
  givenAsPickup?: boolean;
}

/** `removeWeaponEvent` - the inverse of give, and equally illegitimate. */
interface RemoveWeaponEventData {
  pedId?: number;
  weaponType?: number;
}

/**
 * `clearPedTasksEvent` - cancelling a ped's animations. Abused to break
 * out of server-imposed states (cuffs, downed animations).
 */
interface ClearPedTasksEventData {
  pedId?: number;
  immediately?: boolean;
}

/**
 * `weaponDamageEvent` - a client asserting it dealt damage.
 *
 * `overrideDefaultDamage` paired with an inflated `weaponDamage` is the
 * classic one-shot-kill modification. Note this same event also has a
 * forensic hook in InventoryController for the discharge log; multiple
 * handlers on one game event are fine.
 */
interface WeaponDamageEventData {
  weaponType?: number;
  weaponDamage?: number;
  overrideDefaultDamage?: boolean;
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Rolling-window counter keys (unit timestamps, pruned per push). */
type WindowKey = 'Explosion' | 'Projectile' | 'Fire' | 'StunHit';

/** Report-throttle keys - one per detection that throttles. */
type ThrottleKey =
  | 'ExplosionRequest'
  | 'ProjectileNotGranted'
  | 'ProjectileSpam'
  | 'FireAbuse'
  | 'PedTaskTampering'
  | 'IllegalEntitySpawn'
  | 'IllegalObjectSpawn'
  | 'WeaponGiveToOther'
  | 'WeaponRemoveFromOther'
  | 'WeaponDamageModified'
  | 'TazerAbuse';

/** Per-Source counters + throttles; evicted on playerDropped. */
interface SourceEntry {
  Windows: Map<WindowKey, number[]>;
  ThrottledUntilMs: Map<ThrottleKey, number>;
}

/**
 * Weapon-shaped explosionType values - the small allowlist that, when
 * the sender holds NO equipped-weapon bag, warrants cancelling the
 * relay and reporting. Every other explosionType (vehicle, world prop,
 * directed environmental, fireworks, snowball, etc.) legitimately
 * arrives with no weapon behind it - a car blowing up, a petrol pump,
 * a gas canister - so it must NOT be cancelled on the unarmed branch
 * (fail-open: relay, and at most feed the rate window).
 *
 * Numeric indices are the GTA V / FXServer ExplosionType enum
 * (implicit sequential from 0), verified 2026-06-11 against the
 * CitizenFX source (code/client/clrcore/External/World.cs) - NOT the
 * older RenderWare/MTA numbering, which differs and does not apply to
 * the OneSync `explosionType` field. Each value is commented by name.
 */
const WeaponShapedExplosionTypes: ReadonlySet<number> = new Set<number>([
  0, // GRENADE
  1, // GRENADELAUNCHER
  2, // STICKYBOMB
  3, // MOLOTOV
  4, // ROCKET (RPG / homing launcher share this type)
  5, // TANKSHELL
  18, // BULLET (explosive rounds)
  19, // SMOKE_GRENADELAUNCHER
  20, // SMOKE_GRENADE
  21, // BZGAS
  22, // FLARE
  25, // PROGRAMMABLEAR (programmable auto-rifle explosive round)
  32, // PLANE_ROCKET
  33, // VEHICLE_BULLET (vehicle-mounted explosive cannon)
  37, // PROXMINE (proximity mine - thrown weapon)
  38, // VALKYRIE_CANNON
]);

/**
 * Anti-cheat ingestion of FXServer net game events - the engine-level
 * messages OneSync surfaces server-side when a client asks the session
 * to mutate shared state (explosions, projectiles, fires, weapon
 * give/remove on remote peds, task clears, entity creation, weapon
 * damage). Sender attribution comes from FXServer itself, so every
 * detection here rides tier-1 trust; the PAYLOAD remains hostile and
 * every field is typeof-validated before use.
 *
 * CancelEvent() semantics (verified against FXServer source): inside a
 * net game-event handler it blocks the server from RELAYING the event
 * to other clients - it never undoes the action on the offending
 * sender's own client. Inside entityCreating it is stronger: the
 * entity is deleted before it ever exists for anyone.
 *
 * Coexists with InventoryController's weaponDamageEvent forensic hook
 * (discharge log + damage flash) - multiple handlers on one game event
 * are fine; the hook here does only anti-cheat sanity checks.
 *
 * Scoring discipline: detections report through AnticheatService and
 * throttle per Source + detection so a sustained cheat scores once per
 * window instead of once per packet - the AnticheatPolicies weights
 * are tuned for that cadence. The cancel-always detections (the
 * explosion unarmed branch, give/remove weapon, the entityCreating
 * ped/vehicle delete) split the two concerns: CancelEvent() fires on
 * EVERY hostile packet because the relay/delete must always apply,
 * while the DB-backed Report is throttled per Source + type so the
 * default observe (no-kick) mode cannot accrue one anticheat_violations
 * row per packet under a flood.
 */
export class AnticheatEventController {
  private readonly Log = Logger.New('AnticheatEvents');
  private readonly Entries = new Map<number, SourceEntry>();

  /*
   * ── Rate-window tuning ───────────────────────────────────────────
   *
   * Each rate-based detection is a triple: WindowMs (how far back the
   * rolling counter looks), WindowMax (how many events inside that
   * window are still plausible), and ThrottleMs (how long to stay quiet
   * after reporting, so one sustained cheat scores once rather than once
   * per packet - AnticheatPolicies weights assume that cadence).
   *
   * Every Max is set above what normal play produces, not at it. These
   * detections are tier-1 (sender attribution is FXServer's, so a hit is
   * strong evidence) and enforcement defaults to observe, but a false
   * positive still writes a violations row that a human later reads as
   * signal - so the bar is "no legitimate player reaches this", not
   * "most players stay under this".
   */

  /** Grenades/rockets: two per ten seconds outpaces throw-and-cook timing. */
  private readonly ExplosionWindowMs = 10_000;
  private readonly ExplosionWindowMax = 2;
  private readonly ExplosionThrottleMs = 30_000;
  /**
   * Projectiles are the noisiest of the three - a legitimate burst of
   * thrown weapons or a launcher volley can stack up - so the ceiling
   * sits at six per ten seconds rather than the explosion tier's two.
   */
  private readonly ProjectileWindowMs = 10_000;
  private readonly ProjectileWindowMax = 6;
  private readonly ProjectileThrottleMs = 30_000;
  /**
   * Fire events are rare in normal play (molotov, petrol trail), so the
   * window is widened to 30 s to catch a slow drip that a 10 s window
   * would keep resetting past.
   */
  private readonly FireWindowMs = 30_000;
  private readonly FireWindowMax = 5;
  private readonly FireThrottleMs = 60_000;
  /** FXServer's fire-event parser caps the array at 5; the clamp defends against parser drift. */
  private readonly FireUnitsCapPerEvent = 5;
  /**
   * Clearing tasks on a ped you do not own. No window - a single one is
   * already illegitimate, so this throttles reporting only.
   */
  private readonly PedTaskThrottleMs = 30_000;
  /**
   * Object spawning, throttled a full minute - six times longer than the
   * ped/vehicle tier (EntitySpawnReportThrottleMs, 10 s). That gap is
   * deliberate: the object branch is low-confidence and reports WITHOUT
   * cancelling (see OnEntityCreating for why), so its rows are weaker
   * evidence and should not crowd out the cancel-backed ones.
   */
  private readonly EntitySpawnObjectThrottleMs = 60_000;
  /**
   * Per-Source persistence/report throttle for the cancel-always tier-1
   * entity-creation reports (ped/vehicle IllegalEntitySpawn). The cancel
   * fires every packet; this only gates the DB-backed Report so a
   * spammer cannot write one anticheat_violations row per hostile packet
   * while enforcement sits in the default observe (no-kick) mode.
   */
  private readonly EntitySpawnReportThrottleMs = 10_000;
  /**
   * Per-Source persistence/report throttle for the give/remove weapon
   * detections. CancelEvent stays unconditional per packet (the relay
   * must be blocked every time); this gates only Report so the observe
   * mode does not accrue an unbounded row per packet.
   */
  private readonly WeaponGiveRemoveReportThrottleMs = 10_000;
  /** Sane per-application damage ceiling; no catalog weapon overrides past it legitimately. */
  private readonly DamageOverrideCeiling = 100;
  private readonly DamageModifiedThrottleMs = 30_000;
  /**
   * Tazer applications. Three inside fifteen seconds is past what the
   * weapon's own recharge allows, so repeats at that rate mean the
   * cooldown is being bypassed client-side rather than a fast trigger
   * finger.
   */
  private readonly StunWindowMs = 15_000;
  private readonly StunWindowMax = 3;
  private readonly StunThrottleMs = 60_000;

  constructor(
    private readonly State: PlayerStateService,
    private readonly Anticheat: AnticheatService,
    private readonly Inventory: InventoryService,
  ) {
    on('explosionEvent', this.OnExplosion);
    on('startProjectileEvent', this.OnStartProjectile);
    on('fireEvent', this.OnFire);
    on('giveWeaponEvent', this.OnGiveWeapon);
    on('removeWeaponEvent', this.OnRemoveWeapon);
    on('clearPedTasksEvent', this.OnClearPedTasks);
    on('entityCreating', this.OnEntityCreating);
    on('weaponDamageEvent', this.OnWeaponDamage);
    this.Log.Debug(
      'Handlers registered (explosionEvent, startProjectileEvent, fireEvent, giveWeaponEvent, ' +
        'removeWeaponEvent, clearPedTasksEvent, entityCreating, weaponDamageEvent)',
    );
  }

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Drops the rate windows + report throttles.
   */
  Evict(Source: number): void {
    this.Entries.delete(Source);
  }

  /**
   * `explosionEvent` - a client asked the session to play an explosion.
   *
   * The unarmed branch (no equipped-weapon bag) only cancels + reports
   * when the explosionType is WEAPON-SHAPED: environmental explosions
   * (a car blowing up, a petrol pump, a gas canister, directed steam
   * jets) legitimately carry no weapon behind them, so cancelling them
   * would destroy ordinary world destruction. Those relay untouched and
   * at most feed the rate window. Only the small weapon-shaped allowlist
   * (grenades, launchers, sticky/rocket/tank/stun-gas families) warrants
   * the unarmed cancel - cancelling a legitimate car explosion is worse
   * than missing a grenade, so this fails open on every unrecognised
   * type.
   *
   * With a bag the check is rate-only: the catalog does not yet classify
   * which weapons are explosive-capable, so a per-hash gate would
   * false-flag every grenade. Refinement path: add an ExplosiveCapable
   * flag to the item catalog and tighten the bag branch to it.
   */
  private OnExplosion = (Sender: string, Data: ExplosionEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      const Now = Date.now();
      const ExplosionType = FiniteOrNull(Data?.explosionType);
      const Evidence = {
        ExplosionType,
        DamageScale: FiniteOrNull(Data?.damageScale),
        Pos: { X: RoundOrNull(Data?.posX), Y: RoundOrNull(Data?.posY), Z: RoundOrNull(Data?.posZ) },
      };
      const IsWeaponShaped = ExplosionType !== null && WeaponShapedExplosionTypes.has(ExplosionType);
      if (this.Inventory.ReadEquippedBag(Source) === null) {
        if (IsWeaponShaped) {
          // Weapon-shaped explosion with no bag behind it: cancel on
          // every occurrence, report on the throttle - a throttled
          // report must not let the relay through.
          CancelEvent();
          if (this.PassThrottle(Source, 'ExplosionRequest', Now, this.ExplosionThrottleMs)) {
            this.Anticheat.Report(Source, 'ExplosionRequest', Evidence);
          }
          return;
        }
        // Environmental / world explosion (no weapon legitimately
        // attributed): relay it, and fall through to the rate window so
        // a flood of spoofed world explosions still scores.
      }
      const Count = this.CountInWindow(Source, 'Explosion', Now, this.ExplosionWindowMs, 1);
      if (Count > this.ExplosionWindowMax && this.PassThrottle(Source, 'ExplosionRequest', Now, this.ExplosionThrottleMs)) {
        this.Anticheat.Report(Source, 'ExplosionRequest', { ...Evidence, ExplosionsInWindow: Count });
      }
    } catch (Err: unknown) {
      this.Log.Error('explosionEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `startProjectileEvent` - a client created a projectile. Two
   * independent checks: the projectile's weapon hash must match the
   * equipped-weapon bag (joaat crosses the wire sign-ambiguous, both
   * sides normalize through `>>> 0`; a missing hash coerces to 0 and
   * fails the compare, which is correct - a hashless projectile is
   * itself bogus), and the creation rate must stay inside any
   * legitimate throw or launcher cadence.
   */
  private OnStartProjectile = (Sender: string, Data: StartProjectileEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      const Now = Date.now();
      const WeaponHash = Number(Data?.weaponHash) >>> 0;
      const Bag = this.Inventory.ReadEquippedBag(Source);
      const BagHash = Bag === null ? null : Bag.WeaponHash >>> 0;
      if (BagHash === null || WeaponHash !== BagHash) {
        if (this.PassThrottle(Source, 'ProjectileNotGranted', Now, this.ProjectileThrottleMs)) {
          this.Anticheat.Report(Source, 'ProjectileNotGranted', { WeaponHash, BagHash });
        }
      }
      const Count = this.CountInWindow(Source, 'Projectile', Now, this.ProjectileWindowMs, 1);
      if (Count > this.ProjectileWindowMax && this.PassThrottle(Source, 'ProjectileSpam', Now, this.ProjectileThrottleMs)) {
        this.Anticheat.Report(Source, 'ProjectileSpam', { CountInWindow: Count });
      }
    } catch (Err: unknown) {
      this.Log.Error('startProjectileEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `fireEvent` - a client asked for map fires. UNDOCUMENTED event
   * (field names source-derived), so the parse is maximally defensive:
   * `fires` may be absent entirely, in which case the event still
   * counts as one unit - the request itself is the signal. Molotovs
   * and burning wrecks produce legitimate bursts, so only a sustained
   * rate reports, and the policy keeps it observe-only.
   */
  private OnFire = (Sender: string, Data: FireEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      const Now = Date.now();
      const RawUnits = Array.isArray(Data?.fires) ? Data.fires.length : 1;
      const Units = Math.min(RawUnits, this.FireUnitsCapPerEvent);
      const Count = this.CountInWindow(Source, 'Fire', Now, this.FireWindowMs, Units);
      if (Count > this.FireWindowMax && this.PassThrottle(Source, 'FireAbuse', Now, this.FireThrottleMs)) {
        this.Anticheat.Report(Source, 'FireAbuse', { FiresInWindow: Count });
      }
    } catch (Err: unknown) {
      this.Log.Error('fireEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `giveWeaponEvent` - a client gave a weapon to a remotely-owned
   * ped. Verified against FXServer source: this event fires ONLY for
   * client-originated gives; the server's own GiveWeaponToPed is a
   * context RPC executed on the owning client and never re-enters
   * this path. Zero legitimate producers - so CancelEvent fires on
   * EVERY packet (the relay must always be blocked). The DB-backed
   * Report is throttled per Source so a packet flood does not persist
   * one anticheat_violations row per packet while enforcement sits in
   * the default observe (no-kick) mode; the policy weight (kick line =
   * one report) still handles repetition once a report lands.
   */
  private OnGiveWeapon = (Sender: string, Data: GiveWeaponEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      if (typeof Data !== 'object' || Data === null) return;
      const PedID = FiniteOrNull(Data.pedId);
      const WeaponType = FiniteOrNull(Data.weaponType);
      if (PedID === null || WeaponType === null) return;
      CancelEvent();
      const Now = Date.now();
      if (this.PassThrottle(Source, 'WeaponGiveToOther', Now, this.WeaponGiveRemoveReportThrottleMs)) {
        this.Anticheat.Report(Source, 'WeaponGiveToOther', { PedID, WeaponType: WeaponType >>> 0 });
      }
    } catch (Err: unknown) {
      this.Log.Error('giveWeaponEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `removeWeaponEvent` - the removal twin of giveWeaponEvent, with
   * the same trust analysis: server removals are context RPCs that
   * bypass the event path, so any occurrence is tampering. CancelEvent
   * stays per-packet; the Report throttles per Source for the same
   * observe-mode row-flood reason.
   */
  private OnRemoveWeapon = (Sender: string, Data: RemoveWeaponEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      if (typeof Data !== 'object' || Data === null) return;
      const PedID = FiniteOrNull(Data.pedId);
      const WeaponType = FiniteOrNull(Data.weaponType);
      if (PedID === null || WeaponType === null) return;
      CancelEvent();
      const Now = Date.now();
      if (this.PassThrottle(Source, 'WeaponRemoveFromOther', Now, this.WeaponGiveRemoveReportThrottleMs)) {
        this.Anticheat.Report(Source, 'WeaponRemoveFromOther', { PedID, WeaponType: WeaponType >>> 0 });
      }
    } catch (Err: unknown) {
      this.Log.Error('removeWeaponEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `clearPedTasksEvent` - a client cleared tasks on a remotely-owned
   * ped (freeze / ragdoll griefing shape). A client clearing its OWN
   * ped is local and raises no event, and server ClearPedTasks RPCs
   * bypass this path, but fringe legitimate triggers exist (scripted
   * resource interplay), so this observes without cancelling and the
   * policy never auto-kicks.
   */
  private OnClearPedTasks = (Sender: string, Data: ClearPedTasksEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      if (typeof Data !== 'object' || Data === null) return;
      const PedID = FiniteOrNull(Data.pedId);
      if (PedID === null) return;
      const Now = Date.now();
      if (!this.PassThrottle(Source, 'PedTaskTampering', Now, this.PedTaskThrottleMs)) return;
      this.Anticheat.Report(Source, 'PedTaskTampering', { PedID, Immediately: Data.immediately === true });
    } catch (Err: unknown) {
      this.Log.Error('clearPedTasksEvent handler failed', { Err: String(Err) });
    }
  };

  /**
   * `entityCreating` - an entity is being created under OneSync.
   * Only population type 7 (POPTYPE_MISSION - scripted) is judged;
   * ambient population (types 1-5, onesync_population is on) and
   * player peds (POPTYPE_PERMANENT) pass untouched. This server
   * currently spawns NO networked scripted peds or vehicles, so a
   * MISSION ped/vehicle owned by a connected player is unsanctioned:
   * CancelEvent() here deletes the entity before it exists for
   * anyone. GetEntityType is apiset-server (verified against the
   * FXServer native declaration: 1 ped, 2 vehicle, 3 object, 0
   * unknown). The ped/vehicle cancel fires on EVERY packet (the
   * delete must always apply), but the DB-backed Report throttles per
   * Source so a packet flood does not persist one row per packet in
   * the default observe (no-kick) mode.
   *
   * Objects (type 3) are LOW-CONFIDENCE - the client legitimately
   * streams local props and parachute placeholders that should never
   * network, but a future server-created mission object would also
   * resolve to a client owner under OneSync, and the blast radius of a
   * wrong cancel outweighs the value. So objects report WITHOUT cancel
   * and route to the observe-only IllegalObjectSpawn detection type
   * (KickAt null), separate from the ped/vehicle IllegalEntitySpawn.
   */
  private OnEntityCreating = (Handle: number): void => {
    try {
      const Entity = Number(Handle);
      if (!Number.isFinite(Entity) || Entity <= 0) return;
      if (GetEntityPopulationType(Entity) !== 7) return;
      const Owner = Number(NetworkGetEntityOwner(Entity));
      if (!Number.isFinite(Owner) || Owner <= 0) return;
      if (this.State.Get(Owner) === null) return;
      const ModelHash = GetEntityModel(Entity) >>> 0;
      const EntityType = GetEntityType(Entity);
      const Now = Date.now();
      if (EntityType === 1 || EntityType === 2) {
        // Cancel every packet; throttle only the persisted report.
        CancelEvent();
        if (this.PassThrottle(Owner, 'IllegalEntitySpawn', Now, this.EntitySpawnReportThrottleMs)) {
          this.Anticheat.Report(Owner, 'IllegalEntitySpawn', { ModelHash, EntityType });
        }
        return;
      }
      if (EntityType !== 3) return;
      if (this.PassThrottle(Owner, 'IllegalObjectSpawn', Now, this.EntitySpawnObjectThrottleMs)) {
        this.Anticheat.Report(Owner, 'IllegalObjectSpawn', { ModelHash, EntityType });
      }
    } catch (Err: unknown) {
      this.Log.Error('entityCreating handler failed', { Err: String(Err) });
    }
  };

  /**
   * `weaponDamageEvent` sanity hook - coexists with
   * InventoryController's forensic hook on the same event. Two
   * checks: (a) a client override pushing per-application damage past
   * the sane ceiling (`weaponDamage` is 0 unless
   * `overrideDefaultDamage` is set, so the gate only fires on actual
   * overrides), and (b) stun-weapon cadence - the stun gun's recharge
   * cycle makes more than three applications in 15s unreachable
   * without a cheat removing the cooldown.
   */
  private OnWeaponDamage = (Sender: string, Data: WeaponDamageEventData): void => {
    try {
      const Source = this.ResolveSender(Sender);
      if (Source === null) return;
      if (typeof Data !== 'object' || Data === null) return;
      const Now = Date.now();
      const WeaponHash = Number(Data.weaponType) >>> 0;
      const Damage = FiniteOrNull(Data.weaponDamage);
      if (Data.overrideDefaultDamage === true && Damage !== null && Damage > this.DamageOverrideCeiling) {
        if (this.PassThrottle(Source, 'WeaponDamageModified', Now, this.DamageModifiedThrottleMs)) {
          this.Anticheat.Report(Source, 'WeaponDamageModified', { WeaponDamage: Damage, WeaponType: WeaponHash });
        }
      }
      if (StunWeaponHashes.includes(WeaponHash)) {
        const Hits = this.CountInWindow(Source, 'StunHit', Now, this.StunWindowMs, 1);
        if (Hits > this.StunWindowMax && this.PassThrottle(Source, 'TazerAbuse', Now, this.StunThrottleMs)) {
          this.Anticheat.Report(Source, 'TazerAbuse', { HitsInWindow: Hits });
        }
      }
    } catch (Err: unknown) {
      this.Log.Error('weaponDamageEvent handler failed', { Err: String(Err) });
    }
  };

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Net game events deliver the sending player's server id, sometimes
   * as a string - coerce, reject non-finite / non-positive values,
   * and drop senders the state store does not track (mid-disconnect
   * races, spoofed ids).
   */
  private ResolveSender(Sender: unknown): number | null {
    const Source = Number(Sender);
    if (!Number.isFinite(Source) || Source <= 0) return null;
    if (this.State.Get(Source) === null) return null;
    return Source;
  }

  /**
   * Push `Units` event stamps into the Source's rolling window and
   * return the total units still inside it.
   *
   * Prunes in place rather than filtering into a fresh array. Stamps are
   * appended in time order, so every expired one sits at the front and a
   * single splice clears them - where `.filter()` allocated a
   * replacement array and a closure on every call. This runs per damage
   * event, which in a sustained firefight is the highest-frequency
   * handler on the server, so the garbage was worth removing.
   */
  private CountInWindow(Source: number, Key: WindowKey, Now: number, WindowMs: number, Units: number): number {
    const Entry = this.UpsertEntry(Source);
    const Cutoff = Now - WindowMs;
    let Stamps = Entry.Windows.get(Key);
    if (Stamps === undefined) {
      Stamps = [];
      Entry.Windows.set(Key, Stamps);
    }
    let Expired = 0;
    while (Expired < Stamps.length && (Stamps[Expired] ?? 0) < Cutoff) Expired += 1;
    if (Expired > 0) Stamps.splice(0, Expired);
    for (let I = 0; I < Units; I += 1) Stamps.push(Now);
    return Stamps.length;
  }

  /** True when a report for this detection may fire now; arms the throttle when it does. */
  private PassThrottle(Source: number, Key: ThrottleKey, Now: number, ThrottleMs: number): boolean {
    const Entry = this.UpsertEntry(Source);
    if (Now < (Entry.ThrottledUntilMs.get(Key) ?? 0)) return false;
    Entry.ThrottledUntilMs.set(Key, Now + ThrottleMs);
    return true;
  }

  /** Fetch or create a player's rate-window and throttle state. */
  private UpsertEntry(Source: number): SourceEntry {
    let Entry = this.Entries.get(Source);
    if (Entry === undefined) {
      Entry = { Windows: new Map(), ThrottledUntilMs: new Map() };
      this.Entries.set(Source, Entry);
    }
    return Entry;
  }
}

/** Coerce a hostile payload field to a finite number; null keeps the evidence honest when absent. */
function FiniteOrNull(Value: unknown): number | null {
  const N = Number(Value);
  return Number.isFinite(N) ? N : null;
}

/** FiniteOrNull plus one-decimal rounding for coordinate evidence. */
function RoundOrNull(Value: unknown): number | null {
  const N = FiniteOrNull(Value);
  return N === null ? null : Math.round(N * 10) / 10;
}
