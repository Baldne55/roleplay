import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { AnticheatScannerService } from '@/Services/AnticheatScannerService.js';
import type { BleedingService } from '@/Services/BleedingService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;

/**
 * `weaponDamageEvent` payload, as seen by the forensic hook.
 *
 * A wider view of the same event AnticheatEventController inspects - this
 * handler needs the hit targets and the firing entity to write the
 * discharge log, where the anti-cheat one only needs the damage fields.
 *
 * All fields optional and all attacker-controlled: only the sender
 * attribution is supplied by FXServer. `parentGlobalId` in particular is
 * validated through IsFiringEntitySendersOwn before anything is recorded.
 *
 * Both `hitGlobalId` and `hitGlobalIds` exist because a single event may
 * report one victim or many (a shotgun spread, an explosion).
 */
interface WeaponDamageEventData {
  weaponType?: number;
  weaponDamage?: number;
  overrideDefaultDamage?: boolean;
  hitGlobalId?: number;
  hitGlobalIds?: number[];
  parentGlobalId?: number;
  hitComponent?: number;
}
/* eslint-enable @typescript-eslint/naming-convention */
// More CitizenFX engine surface, already PascalCase so outside the pragma.
// The two Network* natives are what let the forensic hook decide whether a
// claimed firing entity really belongs to the sender: an attacker controls
// the network id in the payload, but not who the server thinks owns it.
declare function NetworkGetEntityOwner(Entity: number): number;
declare function NetworkGetEntityFromNetworkId(NetID: number): number;
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetVehiclePedIsIn(Ped: number, LastVehicle: boolean): number;

/**
 * Upper bound on victims iterated from a single `weaponDamageEvent`.
 * The genuine engine event carries only a handful of hit entities, so
 * this caps a forged oversized `hitGlobalIds` array before the loop.
 */
const MaxHitVictims = 16;

/**
 * Server-side handlers for the inventory client surface:
 *   - Drop / pickup requests (re-read coords; client coords advisory)
 *   - Weapon shot pop + reload routing
 *   - `weaponDamageEvent` server game-event hook
 *     -> WeaponDischargeLog forensic trail + the server-written
 *        nametag damage-flash stamp on the victim + the per-victim
 *        bleeding hand-off (BleedingService decides whether the
 *        weapon class opens a wound)
 *
 * Every inbound payload is hostile - the service layer revalidates
 * Phase, character ID, weapon hash, ammo count, rate limit. The
 * controller is the wire transport only.
 */
export class InventoryController {
  private readonly Log = Logger.New('InventoryCtrl');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Inventory: InventoryService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Scanner: AnticheatScannerService,
    private readonly Bleeding: BleedingService,
  ) {
    onNet(NetEvents.InventoryDropRequest, this.OnDropRequest);
    onNet(NetEvents.InventoryPickupRequest, this.OnPickupRequest);
    onNet(NetEvents.InventoryWeaponShot, this.OnWeaponShot);
    onNet(NetEvents.InventoryWeaponReloadRequest, this.OnReloadRequest);
    onNet(NetEvents.InventoryGroundDropResyncRequest, this.OnGroundDropResyncRequest);
    onNet(NetEvents.InventoryCatalogAuditReport, this.OnCatalogAuditReport);
    on('weaponDamageEvent', this.OnWeaponDamage);
    this.Log.Debug(
      'Handlers registered (DropRequest, PickupRequest, WeaponShot, ReloadRequest, GroundDropResyncRequest, CatalogAuditReport, weaponDamageEvent)',
    );
  }

  /*
   * ── Net-event handlers ───────────────────────────────────────────
   *
   * Arrow-function fields rather than methods so `this` stays bound when
   * passed to `onNet` - a plain method reference would lose it.
   *
   * Every one follows the same shape: read `source` (FXServer's sender
   * attribution, the only trustworthy part of the request), check the
   * player is spawned, then typeof-validate each payload field before
   * use. The payload itself is attacker-controlled, so a malformed one is
   * logged and dropped rather than reaching the service.
   */

  /** `/item drop` from the client. Range and ownership re-checked in the service. */
  private OnDropRequest = (
    Payload: NetEventPayloads[typeof NetEvents.InventoryDropRequest],
  ): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    if (
      typeof Payload !== 'object' ||
      Payload === null ||
      typeof Payload.SlotIndex !== 'number' ||
      typeof Payload.Quantity !== 'number'
    ) {
      this.Log.Warn(`InventoryDropRequest bad payload source=${Src}`);
      return;
    }
    void this.Inventory.DropToGround(Src, Payload.SlotIndex, Payload.Quantity);
  };

  /**
   * Pickup request. The DropID is digits-only checked here and re-validated
   * for range and routing bucket in the service - naming a distant drop
   * does not make it reachable.
   */
  private OnPickupRequest = (
    Payload: NetEventPayloads[typeof NetEvents.InventoryPickupRequest],
  ): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    if (
      typeof Payload !== 'object' ||
      Payload === null ||
      typeof Payload.DropID !== 'string' ||
      !/^\d+$/.test(Payload.DropID)
    ) {
      this.Log.Warn(`InventoryPickupRequest bad payload source=${Src}`);
      return;
    }
    void this.Inventory.PickupDrop(Src, Payload.DropID);
  };

  /**
   * A discharge reported by the client - the highest-frequency handler
   * here during a firefight.
   *
   * `ExpectedRemainingAmmo` is the client's claim, not an instruction:
   * the service reconciles it against the authoritative count and feeds
   * the discrepancy to the shot-accounting anti-cheat windows.
   */
  private OnWeaponShot = (
    Payload: NetEventPayloads[typeof NetEvents.InventoryWeaponShot],
  ): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    if (
      typeof Payload !== 'object' ||
      Payload === null ||
      typeof Payload.WeaponHash !== 'number' ||
      typeof Payload.ExpectedRemainingAmmo !== 'number'
    ) {
      this.Log.Warn(`InventoryWeaponShot bad payload source=${Src}`);
      return;
    }
    void this.Inventory.HandleWeaponShot(Src, Payload);
  };

  /** Reload request. No payload - the server decides what is loaded and from where. */
  private OnReloadRequest = (): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    void this.Inventory.Reload(Src);
  };

  /**
   * Client asking to be re-sent the drops around it - after a resource
   * restart or a streaming hiccup left its local props out of step with
   * the server's rows.
   */
  private OnGroundDropResyncRequest = (): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    void this.Inventory.ResyncGroundDropsToSource(Src);
  };

  /**
   * Results of an admin's `/aitem testcatalog` sweep.
   *
   * Typed `unknown` deliberately - this payload is the widest hostile
   * surface in the file, so it is sanitised field by field in the service
   * rather than trusted to a declared shape here.
   */
  private OnCatalogAuditReport = (Payload: unknown): void => {
    const Src = source;
    if (!this.AssertSpawned(Src)) return;
    // Deep sanitisation happens in the service; it also drops reports
    // with no pending audit for this Source.
    this.Inventory.HandleCatalogAuditReport(Src, Payload);
  };

  /**
   * `weaponDamageEvent` - the net game event FXServer raises
   * server-side when a client asks to apply weapon damage to a
   * remotely-owned entity (OneSync). Sender is already the shooter's
   * server id; victims arrive as network object ids in
   * `hitGlobalIds`, each resolved to a player only when the hit
   * entity is that player's own ped (vehicle hits do not flash the
   * driver).
   *
   * Coverage: player-vs-player damage always fires - a player ped is
   * owned by its own client, never the shooter's. Self-damage
   * (falls, fire) and damage to entities the shooter's client owns
   * (nearby ambient peds) raise no event, so those neither flash nor
   * log. `weaponDamage` is 0 unless the client overrides the
   * weapon-meta default, so the logged Damage is usually 0.
   *
   * Attribution gate: Sender is the damaging *client*, which also
   * relays shots fired by NPCs that client owns. The discharge is
   * only pinned on Sender when `parentGlobalId` (the firing entity)
   * is Sender's own ped or current vehicle (drive-bys) - otherwise
   * an NPC shot would log against whatever weapon its owner carries.
   */
  private OnWeaponDamage = (Sender: string, Data: WeaponDamageEventData): void => {
    const Shooter = Number(Sender);
    if (!Number.isFinite(Shooter) || Shooter <= 0) return;
    if (typeof Data !== 'object' || Data === null) return;
    const RawWeapon = Number(Data.weaponType);
    const Damage = Number(Data.weaponDamage);
    if (!Number.isFinite(RawWeapon) || !Number.isFinite(Damage)) return;
    // Joaat hashes cross the wire sign-ambiguous; normalize to uint32.
    const WeaponHash = RawWeapon >>> 0;
    // Attribution gate first: the flash and the GodModeHealth hit
    // window are both side effects that a modded client could weaponise
    // by forging an arbitrary hitGlobalIds list to frame innocents. The
    // event is only trustworthy when the firing entity is the sender's
    // own ped or current vehicle (matching the discharge path below), so
    // nothing in the hit loop runs for damage the sender cannot own.
    if (!IsFiringEntitySendersOwn(Shooter, Number(Data.parentGlobalId))) return;
    // Deduplicate the victim list through a Set and cap its length: the
    // real engine event carries only a handful of victims, so a forged
    // ten-thousand-entry array must not be allowed to spin the loop.
    const RawHitNetIDs =
      Array.isArray(Data.hitGlobalIds) && Data.hitGlobalIds.length > 0
        ? Data.hitGlobalIds
        : [Number(Data.hitGlobalId)];
    const HitNetIDs = [...new Set(RawHitNetIDs.map(Number))].slice(0, MaxHitVictims);
    // Raw ped component id the shot landed on - null when the event
    // omits it. Parsed ahead of the victim loop because the bleeding
    // hand-off consumes it per victim; the discharge log takes it
    // untranslated for the /ac stats distribution.
    const RawHitComponent = Number(Data.hitComponent);
    const HitComponent = Number.isFinite(RawHitComponent) ? RawHitComponent : null;
    let Victim: number | null = null;
    for (const NetID of HitNetIDs) {
      const HitSource = ResolvePlayerPedNetIDToSource(NetID);
      if (HitSource === null) continue;
      // Server-written nametag damage flash - the client no longer
      // self-reports its own HP drops.
      this.Runtimes.PublishDamageFlash(HitSource);
      // Feed the GodModeHealth hit window - a confirmed hit on this
      // victim that should move their replicated HP or armour.
      this.Scanner.NoteHit(HitSource);
      // Bleeding hand-off - the service decides whether the weapon
      // class can open a wound and runs its own confirm delay.
      this.Bleeding.OnHit(HitSource, WeaponHash, HitComponent);
      Victim ??= HitSource;
    }
    // Pistol-whipping (a melee hit while a firearm is equipped) raises a
    // weaponDamageEvent whose weaponType is the firearm, so it should NOT
    // count toward ShotsUnreported nor log a discharge row with the gun's
    // serial. The melee skip is DEFERRED: the FiveM docs expose a
    // damageType field (0..3) but state "Specific values are currently
    // unknown", and no authoritative enum mapping the melee value could
    // be located in the FXServer source. Guessing the enum would risk
    // dropping genuine bullet discharges, so RecordWeaponDischarge is
    // left intact pending the verified melee damageType value.
    void this.Inventory.RecordWeaponDischarge(Shooter, Victim, WeaponHash, Damage, HitComponent);
  };

  /** Whether a Source has a character in the world; gates every net handler here. */
  private AssertSpawned(Src: number): boolean {
    return this.State.Get(Src)?.Phase === 'Spawned';
  }
}

/**
 * Verify that the entity a damage event claims did the firing actually
 * belongs to the sender.
 *
 * The anti-spoof check on the discharge log: without it a client could
 * report damage as though it came from someone else's ped and attribute
 * its own shots to another player. The sender's identity is supplied by
 * FXServer and is trustworthy; the `parentGlobalId` in the payload is
 * not, so it gets validated against that.
 *
 * Accepts the sender's vehicle as well as their ped, because a drive-by
 * legitimately reports the vehicle as the firing entity.
 */
function IsFiringEntitySendersOwn(Sender: number, ParentNetID: number): boolean {
  if (!Number.isFinite(ParentNetID) || ParentNetID <= 0) return false;
  try {
    const Firing = NetworkGetEntityFromNetworkId(ParentNetID);
    if (Firing === 0) return false;
    const SenderPed = GetPlayerPed(String(Sender));
    if (Firing === SenderPed) return true;
    // Drive-bys may report the vehicle as the firing entity.
    return GetVehiclePedIsIn(SenderPed, false) === Firing;
  } catch {
    return false;
  }
}

/**
 * Resolve a hit entity's network id to the player it belongs to, or null
 * if it is not a player ped at all.
 *
 * The equality check at the end is doing real work: it is what makes this
 * reject vehicles, props and NPC peds, since only a player's own ped
 * satisfies "the owner's ped IS this entity". Without it a hit on a
 * player-owned vehicle would be logged as a hit on the player.
 */
function ResolvePlayerPedNetIDToSource(NetID: number): number | null {
  if (!Number.isFinite(NetID) || NetID <= 0) return null;
  try {
    const Entity = NetworkGetEntityFromNetworkId(NetID);
    if (Entity === 0) return null;
    // Server-side NetworkGetEntityOwner returns the owning source id
    // directly. A player ped is always owned by its own client, so
    // Owner is the victim iff the hit entity IS the owner's ped - the
    // equality check also rejects vehicles and props.
    const Owner = NetworkGetEntityOwner(Entity);
    if (Owner <= 0) return null;
    if (GetPlayerPed(String(Owner)) !== Entity) return null;
    return Owner;
  } catch {
    return null;
  }
}
