import { EquippedWeaponBagKey, PlaceholderGroundProp } from '@Shared/Constants/Inventory.js';
import { ItemTypes } from '@Shared/Constants/ItemTypes.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
declare function setTick(Callback: () => void): number;
declare function clearTick(Handle: number): void;
declare function PlayerPedId(): number;
declare function PlayerId(): number;
declare function GetPlayerServerId(PlayerId: number): number;
declare function GetGameTimer(): number;
declare function GetEntityCoords(
  Entity: number,
  Alive?: boolean,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetPedAmmoFromPed(Ped: number, WeaponHash: number): number;
declare function GetAmmoInPedWeapon(Ped: number, WeaponHash: number): number;
declare function IsWeaponValid(WeaponHash: number): boolean;
declare function HasPedGotWeapon(Ped: number, WeaponHash: number, P2: boolean): boolean;
declare function GetWeaponClipSize(WeaponHash: number): number;
declare function DoesWeaponTakeWeaponComponent(WeaponHash: number, ComponentHash: number): boolean;
declare function GetWeaponComponentTypeModel(ComponentHash: number): number;
declare function SetPedDropsWeaponsWhenDead(Ped: number, Toggle: boolean): void;
declare function RemoveAllPedWeapons(Ped: number, P1: boolean): void;
declare function SetPedAmmo(Ped: number, WeaponHash: number, Ammo: number): void;
declare function SetPickupGenerationRangeMultiplier(Multiplier: number): void;
declare function AddStateBagChangeHandler(
  KeyFilter: string,
  BagFilter: string,
  Callback: (
    BagName: string,
    Key: string,
    Value: unknown,
    Reserved: number,
    Replicated: boolean,
  ) => void,
): number;
declare const LocalPlayer: {
  state: { [Key: string]: unknown };
};
declare function NetworkSetFriendlyFireOption(Toggle: boolean): void;
declare function SetCanAttackFriendly(Ped: number, AttackFriendly: boolean, IncludeRagdoll: boolean): void;
declare function SetWeaponsNoAutoswap(Toggle: boolean): void;
declare function GetHashKey(Value: string): number;
declare function CreateObject(
  Hash: number,
  X: number,
  Y: number,
  Z: number,
  IsNetwork: boolean,
  IsScripted: boolean,
  Dynamic: boolean,
): number;
declare function SetEntityCollision(Entity: number, On: boolean, KeepPhysics: boolean): void;
declare function GetModelDimensions(
  Hash: number,
): [[number, number, number], [number, number, number]];
declare function SetEntityCoordsNoOffset(
  Entity: number,
  X: number,
  Y: number,
  Z: number,
  AxisX: boolean,
  AxisY: boolean,
  AxisZ: boolean,
): void;
declare function GetGroundZFor_3dCoord(
  X: number,
  Y: number,
  Z: number,
  IgnoreWater: boolean,
): [boolean, number];
declare function SetEntityRotation(
  Entity: number,
  Pitch: number,
  Roll: number,
  Yaw: number,
  RotationOrder: number,
  P5: boolean,
): void;
declare function FreezeEntityPosition(Entity: number, Toggle: boolean): void;
declare function DeleteEntity(Entity: number): void;
declare function DeleteObject(Entity: number): void;
declare function DoesEntityExist(Entity: number): boolean;
declare function SetEntityAsMissionEntity(Entity: number, P2: boolean, P3: boolean): void;
declare function RequestModel(Hash: number): void;
declare function HasModelLoaded(Hash: number): boolean;
declare function IsModelValid(Hash: number): boolean;
declare function IsModelInCdimage(Hash: number): boolean;
declare function SetModelAsNoLongerNeeded(Hash: number): void;
declare function SetDrawOrigin(X: number, Y: number, Z: number, P3: number): void;
declare function ClearDrawOrigin(): void;
declare function SetTextScale(Scale: number, Size: number): void;
declare function SetTextColour(R: number, G: number, B: number, A: number): void;
declare function SetTextCentre(Toggle: boolean): void;
declare function SetTextDropshadow(Distance: number, R: number, G: number, B: number, A: number): void;
declare function SetTextOutline(): void;
declare function BeginTextCommandDisplayText(Format: string): void;
declare function EndTextCommandDisplayText(X: number, Y: number): void;
declare function AddTextEntry(Key: string, Body: string): void;
/* eslint-enable @typescript-eslint/naming-convention */

// 25ms (~2 frames at 60fps): no two pistol rounds can land inside one
// window, so each WeaponShot event represents exactly one round - the
// unit the server-side accounting and rate limits are sized for.
const AmmoPollIntervalMs = 25;
// Settle window between the server-side audit give and the client
// sweep, so the replicated loadout has landed before HasPedGotWeapon
// reads it.
const CatalogAuditSettleMs = 1_500;
// World ammo/weapon pickups are blocked outright: the inventory is
// server-authoritative, so the engine must never hand the local ped
// rounds the server did not grant. Collapsing the ambient pickup
// generation radius to zero is the cheap first line of defence; the
// ammo poll's clamp (PollAmmo) is the authoritative backstop for any
// pre-existing world pickup (e.g. a weapon a dead NPC dropped) that
// the generation radius does not cover.
const PickupGenerationRangeOff = 0;
/*
 * Ground-drop floating label. The label fades between these two radii
 * rather than popping, so a drop becomes readable as the player closes on
 * it. Inside the first it is fully opaque; past the second it is not
 * drawn at all.
 */
const LabelFullOpacityRangeMeters = 5;
const LabelHiddenRangeMeters = 7;
/** Text size for the label. Small - drops cluster, and these must not overlap. */
const LabelTextScale = 0.35;
/** GTA font index (4 = the condensed UI face used elsewhere in the HUD). */
const LabelTextFontSize = 4;
/**
 * The `p7` argument of SetTextEntry/DrawText's world-space path. Always 0
 * here; it selects a networked-label mode this drop label does not use.
 */
const LabelDrawNetworkParam = 0;

/**
 * Local projection of the server's `Roleplay:EquippedWeapon` bag. Only
 * the fields the ammo poll needs - the weapon natives themselves run
 * server-side, so the row identity / serial / component set never
 * matter on this side anymore.
 */
interface EquippedWeaponLocal {
  WeaponHash: number;
  LoadedAmmoTotal: number;
}

/**
 * One server-spawned ground drop this client is tracking.
 *
 * Mirrors a row the server owns; the client only renders it. `PropEntity`
 * is null until the model streams in, so every consumer must handle the
 * not-yet-spawned case - the label tick in particular walks this whole
 * collection every frame.
 */
interface GroundDropEntry {
  DropID: string;
  X: number;
  Y: number;
  Z: number;
  Label: string;
  PropEntity: number | null;
  ModelHash: number;
  /** Catalog-driven prop rotation (decal-plane fixtures); null = engine default. */
  Rotation: { Pitch: number; Roll: number; Yaw: number } | null;
}

/**
 * Lowest corner of the model's bounding box, in entity-local Z, after
 * the catalog rotation (ZXY application, matching SetEntityRotation
 * order 2; world-Z is independent of yaw). Decal-plane props are
 * authored with their geometry offset from the entity origin (a wall
 * splat floats off its wall), so once pitched flat the visible plane
 * hangs above the origin - the spawn path uses this to re-anchor the
 * rotated floor onto the ground. Null when the dimensions native is
 * unavailable.
 */
function RotatedModelMinZ(
  Hash: number,
  Rotation: { Pitch: number; Roll: number; Yaw: number },
): number | null {
  let Min: [number, number, number];
  let Max: [number, number, number];
  try {
    [Min, Max] = GetModelDimensions(Hash);
  } catch {
    return null;
  }
  // World-Z row of Rz(Yaw)*Rx(Pitch)*Ry(Roll): the yaw term drops out.
  const Rad = Math.PI / 180;
  const CoefX = -Math.cos(Rotation.Pitch * Rad) * Math.sin(Rotation.Roll * Rad);
  const CoefY = Math.sin(Rotation.Pitch * Rad);
  const CoefZ = Math.cos(Rotation.Pitch * Rad) * Math.cos(Rotation.Roll * Rad);
  return (
    Math.min(CoefX * Min[0], CoefX * Max[0]) +
    Math.min(CoefY * Min[1], CoefY * Max[1]) +
    Math.min(CoefZ * Min[2], CoefZ * Max[2])
  );
}

/**
 * Client half of the inventory surface.
 *
 *   1. Equipped-weapon lifecycle, driven entirely by the replicated
 *      `Roleplay:EquippedWeapon` state bag. The server applies the
 *      weapon natives itself (give / remove / components / SetPedAmmo
 *      are apiset-server) - this side only starts/stops the ammo poll
 *      on the bag transitions. After the server gives or reloads, the
 *      ped's replicated ammo lags the bag write by a sync frame, so
 *      the poll holds its emits until the local read catches up to
 *      the bag total (`AmmoSynced`).
 *   2. 25ms ammo poll while the equipped weapon is non-null. When
 *      the local ammo read drops below the last sampled value, emits
 *      `Roleplay:Net:Inventory:WeaponShot` with the new total. Server
 *      pops the FIFO segment, persists, re-publishes the state bag.
 *      (Client-observed because FXServer has no apiset-server ammo
 *      getter - the server clamps every claim regardless.)
 *   3. Ground-drop registry. On `GroundDropSpawn` spawns the
 *      placeholder prop + 3D label; despawns on `GroundDropDespawn`.
 *      Label fades by distance (full inside 5m, hidden past 7m).
 *
 * Gates on the SPA's Spawned phase: `CharacterSpawned` -> on,
 * `SessionReturnToSelect` / `SessionReturnToAuth` -> off + drain
 * registries. Mirrors the InjuryController gate.
 */
export class InventoryController {
  private readonly Log = Logger.New('Inventory');
  private IsSpawned = false;

  private EquippedWeapon: EquippedWeaponLocal | null = null;
  /** Last local ammo sample - drives the WeaponShot emit. */
  private LastPolledAmmo = 0;
  /** False while waiting for a server give/reload to replicate down. */
  private AmmoSynced = false;
  private AmmoPollInterval: ReturnType<typeof setInterval> | null = null;
  private LastShotEmitAt = 0;

  /** DropID -> entry. */
  private readonly GroundDrops = new Map<string, GroundDropEntry>();
  private LabelTick: number | null = null;

  constructor() {
    AddTextEntry('RP_INV_LABEL', '~s~~a~');

    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
      this.StartLabelTick();
      // Enable PvP / friendly-fire so players can damage each other.
      try {
        NetworkSetFriendlyFireOption(true);
      } catch {
        // Best-effort.
      }
      const Ped = PlayerPedId();
      if (Ped !== 0) {
        try {
          SetCanAttackFriendly(Ped, true, false);
        } catch {
          // Best-effort.
        }
        // The engine drops a held weapon as a world pickup on death by
        // default - a parallel item economy outside the inventory's
        // accounting (and the death-snapshot flow). Suppress it.
        try {
          SetPedDropsWeaponsWhenDead(Ped, false);
        } catch {
          // Best-effort.
        }
      }
      // The engine auto-swaps to the next-best weapon (fists) the
      // moment the held weapon runs dry, which reads as the gun
      // vanishing from the hands. Keep holding the empty weapon -
      // the trigger dry-clicks until /reload refills it.
      try {
        SetWeaponsNoAutoswap(true);
      } catch {
        // Best-effort.
      }
      // Collapse the ambient pickup generation radius to zero so the
      // engine stops spawning world weapon/ammo pickups around this
      // player. World ammo acquisition is intentionally blocked -
      // every round must originate from the server-authoritative
      // ledger. Pre-existing pickups outside this radius (e.g. a
      // weapon a dead NPC dropped) are caught by the ammo poll's
      // clamp instead.
      try {
        SetPickupGenerationRangeMultiplier(PickupGenerationRangeOff);
      } catch {
        // Best-effort.
      }
      // The bag may already carry a value by the time CharacterSpawned
      // lands (the server writes state bags before the spawn event).
      // Sync the poll lifecycle off the current value, mirroring the
      // InjuryController's initial-status read.
      try {
        this.ApplyEquippedBag(LocalPlayer.state[EquippedWeaponBagKey]);
      } catch {
        // Bag read can fail mid-resource-restart; the change handler
        // below covers every later transition.
      }
      setTimeout((): void => {
        if (!this.IsSpawned) return;
        emitNet(NetEvents.InventoryGroundDropResyncRequest, {});
      }, 1500);
    });

    const ReturnHandler = (): void => {
      this.IsSpawned = false;
      this.StopAmmoPoll();
      this.StopLabelTick();
      this.DrainGroundDrops();
      this.EquippedWeapon = null;
      const Ped = PlayerPedId();
      if (Ped !== 0) {
        try {
          RemoveAllPedWeapons(Ped, true);
        } catch (Err: unknown) {
          this.Log.Warn(`RemoveAllPedWeapons failed`, { Err: String(Err) });
        }
      }
    };
    onNet(NetEvents.SessionReturnToSelect, ReturnHandler);
    onNet(NetEvents.SessionReturnToAuth, ReturnHandler);

    // FX state bags publish under `player:<serverId>`. Filter on the
    // EquippedWeapon key only; check the bag name inside the handler
    // (same idiom as the InjuryController's InjuryStatus listener).
    AddStateBagChangeHandler(
      EquippedWeaponBagKey,
      '',
      (BagName, _Key, Value): void => {
        if (!this.IsSpawned) return;
        const SelfBag = `player:${GetPlayerServerId(PlayerId())}`;
        if (BagName !== SelfBag) return;
        this.ApplyEquippedBag(Value);
      },
    );

    onNet(
      NetEvents.InventoryGroundDropSpawn,
      (Payload: NetEventPayloads[typeof NetEvents.InventoryGroundDropSpawn]): void => {
        if (!this.IsSpawned) return;
        this.SpawnGroundDrop(Payload);
      },
    );

    onNet(
      NetEvents.InventoryGroundDropDespawn,
      (Payload: NetEventPayloads[typeof NetEvents.InventoryGroundDropDespawn]): void => {
        this.DespawnGroundDrop(Payload.DropID);
      },
    );

    onNet(NetEvents.InventoryCatalogAuditRequest, (): void => {
      if (!this.IsSpawned) return;
      setTimeout((): void => {
        this.RunCatalogAudit();
      }, CatalogAuditSettleMs);
    });

    this.Log.Debug(
      'Handlers registered (CharacterSpawned, SessionReturnTo*, EquippedWeapon bag, GroundDropSpawn/Despawn, CatalogAuditRequest)',
    );
  }

  // ── Catalog audit sweep ─────────────────────────────────────────────

  /**
   * `/aitem testcatalog` round-trip, client half. The server already
   * gave this ped every catalog weapon; sweep the whole catalog
   * through the engine's own validity natives and report back. The
   * engine discards an unrecognised hash silently, so these reads are
   * the only ground truth for the running game build:
   *
   *   - IsWeaponValid: the weapon info exists in this build.
   *   - HasPedGotWeapon: the server-side give actually landed.
   *   - DoesWeaponTakeWeaponComponent: every CompatibleWeaponHashes
   *     pairing is one the engine accepts.
   *   - GetWeaponClipSize vs MaxAmmo: informational balance drift.
   *   - WorldObjectModel streams as a real model (drop props).
   */
  private RunCatalogAudit(): void {
    const Ped = PlayerPedId();
    const Report: NetEventPayloads[typeof NetEvents.InventoryCatalogAuditReport] = {
      CheckedWeapons: 0,
      CheckedComponents: 0,
      ResolvedComponentModels: 0,
      InvalidWeapons: [],
      MissingWeapons: [],
      ComponentRejections: [],
      ClipSizeMismatches: [],
      InvalidDropModels: [],
    };
    const WeaponIDByHash = new Map<number, string>();
    for (const Type of Object.values(ItemTypes)) {
      if (Type.IsWeapon === true && Type.WeaponHash !== undefined) {
        WeaponIDByHash.set(Type.WeaponHash, Type.ID);
      }
    }
    for (const Type of Object.values(ItemTypes)) {
      // Drop-prop model check applies to every catalog item that
      // declares one - weapons, ammo boxes, consumables, papers, keys.
      if (Type.WorldObjectModel !== undefined) {
        let ModelOk = false;
        try {
          const ModelHash = GetHashKey(Type.WorldObjectModel);
          ModelOk = IsModelInCdimage(ModelHash) && IsModelValid(ModelHash);
        } catch {
          // Treated as invalid below.
        }
        if (!ModelOk) Report.InvalidDropModels.push(Type.ID);
      }
      if (Type.IsWeapon === true && Type.WeaponHash !== undefined) {
        Report.CheckedWeapons += 1;
        let Valid = false;
        try {
          Valid = IsWeaponValid(Type.WeaponHash);
        } catch {
          // Treated as invalid below.
        }
        if (!Valid) {
          Report.InvalidWeapons.push(Type.ID);
        } else if (Ped === 0 || !HasPedGotWeapon(Ped, Type.WeaponHash, false)) {
          Report.MissingWeapons.push(Type.ID);
        }
        if (Valid && Type.MaxAmmo !== undefined) {
          try {
            const Engine = GetWeaponClipSize(Type.WeaponHash);
            if (Engine > 0 && Engine !== Type.MaxAmmo) {
              Report.ClipSizeMismatches.push({
                ID: Type.ID,
                Engine,
                Catalog: Type.MaxAmmo,
              });
            }
          } catch {
            // Clip size is informational only.
          }
        }
      }
      if (Type.IsWeaponComponent === true && Type.ComponentHash !== undefined) {
        Report.CheckedComponents += 1;
        // Drop-prop model, resolved from the engine. Zero means the
        // engine carries no model for this component (some skins) -
        // those fall back to the placeholder prop by design and are
        // not a failure; a non-zero model that does not stream is.
        let CompModel = 0;
        try {
          CompModel = GetWeaponComponentTypeModel(Type.ComponentHash);
        } catch {
          // Treated as model-less below.
        }
        if (CompModel !== 0) {
          let ModelOk = false;
          try {
            ModelOk = IsModelInCdimage(CompModel) && IsModelValid(CompModel);
          } catch {
            // Treated as invalid below.
          }
          if (ModelOk) Report.ResolvedComponentModels += 1;
          else Report.InvalidDropModels.push(Type.ID);
        }
        for (const WeaponHash of Type.CompatibleWeaponHashes ?? []) {
          const WeaponID = WeaponIDByHash.get(WeaponHash);
          if (WeaponID === undefined) continue;
          let Takes = false;
          try {
            Takes = DoesWeaponTakeWeaponComponent(WeaponHash, Type.ComponentHash);
          } catch {
            // Treated as a rejection below.
          }
          if (!Takes) {
            Report.ComponentRejections.push({ Component: Type.ID, Weapon: WeaponID });
          }
        }
      }
    }
    emitNet(NetEvents.InventoryCatalogAuditReport, Report);
    this.Log.Info('Catalog audit swept', {
      Weapons: Report.CheckedWeapons,
      Components: Report.CheckedComponents,
      ComponentModels: Report.ResolvedComponentModels,
      Invalid: Report.InvalidWeapons.length,
      Missing: Report.MissingWeapons.length,
      Rejections: Report.ComponentRejections.length,
      ClipDrift: Report.ClipSizeMismatches.length,
      BadModels: Report.InvalidDropModels.length,
    });
  }

  // ── Equipped-weapon bag lifecycle ───────────────────────────────────

  /**
   * Drive the ammo-poll lifecycle from a bag transition. Three cases:
   *
   *   null            -> stop the poll, forget the weapon.
   *   new / new hash  -> remember it, start the poll in the unsynced
   *                      state (the server's give + SetPedAmmo have
   *                      not replicated to the local ped yet).
   *   same hash       -> ammo bookkeeping. A higher total than the
   *                      last local sample is a server-side reload -
   *                      re-enter the unsynced state until the ped
   *                      catches up. A lower-or-equal total is the
   *                      server confirming shot pops the poll already
   *                      observed locally - nothing to do.
   */
  private ApplyEquippedBag(Value: unknown): void {
    const Bag = NormaliseEquippedBag(Value);
    if (Bag === null) {
      this.EquippedWeapon = null;
      this.StopAmmoPoll();
      return;
    }
    const Previous = this.EquippedWeapon;
    this.EquippedWeapon = Bag;
    if (Previous === null || Previous.WeaponHash !== Bag.WeaponHash) {
      this.LastPolledAmmo = Bag.LoadedAmmoTotal;
      this.AmmoSynced = false;
      this.StartAmmoPoll();
      return;
    }
    if (Bag.LoadedAmmoTotal > this.LastPolledAmmo) {
      this.LastPolledAmmo = Bag.LoadedAmmoTotal;
      this.AmmoSynced = false;
    }
  }

  // ── Ammo poll ───────────────────────────────────────────────────────

  /**
   * Begin polling the equipped weapon's magazine.
   *
   * The engine fires no event when a round is spent, so the count has to
   * be sampled and reported to the server, which owns ammunition
   * authoritatively.
   */
  private StartAmmoPoll(): void {
    if (this.AmmoPollInterval !== null) return;
    this.AmmoPollInterval = setInterval((): void => {
      this.PollAmmo();
    }, AmmoPollIntervalMs);
  }

  /** Stop the ammo poll when nothing is equipped. */
  private StopAmmoPoll(): void {
    if (this.AmmoPollInterval === null) return;
    clearInterval(this.AmmoPollInterval);
    this.AmmoPollInterval = null;
    this.LastPolledAmmo = 0;
    this.AmmoSynced = false;
  }

  /**
   * Sample the magazine and report changes to the server.
   *
   * Reports deltas, not absolutes: the server decides what the count
   * becomes, so a client claiming an impossible magazine is corrected
   * rather than believed.
   */
  private PollAmmo(): void {
    if (!this.IsSpawned || this.EquippedWeapon === null) return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    const Current = this.ReadPedAmmo(Ped, this.EquippedWeapon.WeaponHash);
    if (Current === null) return;
    if (!this.AmmoSynced) {
      // A server-side give or SetPedAmmo is still replicating down;
      // the local read undershoots the bag total until it lands.
      // Emitting now would report phantom shots - hold until synced.
      if (Current >= this.LastPolledAmmo) {
        this.AmmoSynced = true;
        this.LastPolledAmmo = Current;
      }
      return;
    }
    if (Current > this.LastPolledAmmo) {
      // The engine ammo rose above the last sample while synced, with
      // no preceding server bag write (a legitimate reload always
      // arrives first through ApplyEquippedBag, which lowers
      // AmmoSynced so this branch is skipped). An unsanctioned gain
      // is a world pickup - the player walked over a weapon/ammo
      // pickup the server never granted. World ammo acquisition is
      // intentionally blocked because the inventory is
      // server-authoritative, so clamp the engine read straight back
      // down to the server-known total before the extra rounds can be
      // fired (which would pop the server FIFO to zero and trip the
      // InfiniteAmmo underflow detector on a legitimate player).
      try {
        SetPedAmmo(Ped, this.EquippedWeapon.WeaponHash, this.LastPolledAmmo);
      } catch {
        // Native missing; the server still clamps every claim, so the
        // worst case is the observe-only InfiniteAmmo flag - never a
        // grant the server honours.
      }
      this.Log.Debug(
        `PollAmmo world pickup clamped hash=${this.EquippedWeapon.WeaponHash} last=${this.LastPolledAmmo} engine=${Current}`,
      );
      return;
    }
    if (Current === this.LastPolledAmmo) {
      return;
    }
    const Now = Date.now();
    if (Now - this.LastShotEmitAt < 50) return;
    this.LastShotEmitAt = Now;
    const Payload: NetEventPayloads[typeof NetEvents.InventoryWeaponShot] = {
      ExpectedRemainingAmmo: Current,
      WeaponHash: this.EquippedWeapon.WeaponHash,
      Timestamp: GetGameTimer(),
    };
    emitNet(NetEvents.InventoryWeaponShot, Payload);
    this.Log.Debug(
      `PollAmmo shot detected hash=${this.EquippedWeapon.WeaponHash} last=${this.LastPolledAmmo} current=${Current}`,
    );
    this.LastPolledAmmo = Current;
  }

  /**
   * Read ped ammo for the given weapon. The canonical native is
   * `GetAmmoInPedWeapon` (hash 0x015A522136D7F951); some FXServer
   * builds also expose the older `GetPedAmmoFromPed`. Try the
   * canonical first, fall back to the legacy if missing.
   */
  private ReadPedAmmo(Ped: number, WeaponHash: number): number | null {
    try {
      const V = GetAmmoInPedWeapon(Ped, WeaponHash);
      if (Number.isFinite(V)) return V;
    } catch {
      // Native missing; fall through to legacy below.
    }
    try {
      const V = GetPedAmmoFromPed(Ped, WeaponHash);
      if (Number.isFinite(V)) return V;
    } catch {
      // Both natives unavailable - poll cannot work.
    }
    return null;
  }

  // ── Ground-drop registry ────────────────────────────────────────────

  /**
   * Track a server-announced drop and begin spawning its prop.
   *
   * The entry is recorded immediately but its `PropEntity` stays null
   * until the model streams in, so the label tick must tolerate
   * not-yet-spawned entries.
   */
  private SpawnGroundDrop(
    Payload: NetEventPayloads[typeof NetEvents.InventoryGroundDropSpawn],
  ): void {
    if (this.GroundDrops.has(Payload.DropID)) return;
    let ModelHash: number;
    if (Payload.Model === '') {
      ModelHash = 0;
    } else {
      try {
        ModelHash = GetHashKey(Payload.Model);
      } catch {
        ModelHash = 0;
      }
    }
    // Weapon-component drops resolve their prop model from the engine -
    // the catalog stores no model names for components. When the engine
    // carries no model for this component (some skins), the Model
    // string above (the placeholder prop) stays in effect.
    if (typeof Payload.ComponentHash === 'number' && Payload.ComponentHash !== 0) {
      try {
        const Resolved = GetWeaponComponentTypeModel(Payload.ComponentHash);
        if (Resolved !== 0) ModelHash = Resolved;
      } catch {
        // Keep the string-model fallback.
      }
    }
    const Entry: GroundDropEntry = {
      DropID: Payload.DropID,
      X: Payload.X,
      Y: Payload.Y,
      Z: Payload.Z,
      Label: Payload.Label,
      PropEntity: null,
      ModelHash,
      Rotation: Payload.Rotation ?? null,
    };
    this.GroundDrops.set(Payload.DropID, Entry);
    if (ModelHash !== 0) this.SpawnPropWhenLoaded(Entry, 0);
  }

  /**
   * Retry prop creation until the model streams in, giving up after a
   * bounded number of attempts.
   *
   * Model loading is asynchronous and can fail outright for a bad model,
   * so the attempt cap is what stops a single unloadable drop retrying
   * forever every frame.
   */
  private SpawnPropWhenLoaded(Entry: GroundDropEntry, Attempt: number): void {
    if (!this.GroundDrops.has(Entry.DropID)) return;
    if (Entry.PropEntity !== null) return;
    if (Entry.ModelHash === 0) return;
    if (Attempt === 0) {
      let Valid = true;
      let InCdimage = true;
      try {
        Valid = IsModelValid(Entry.ModelHash);
      } catch {
        // Native missing; assume valid and let CreateObject decide.
      }
      try {
        InCdimage = IsModelInCdimage(Entry.ModelHash);
      } catch {
        // Native missing; same.
      }
      this.Log.Debug(
        `Prop spawn start drop=${Entry.DropID} hash=${Entry.ModelHash} valid=${Valid} cdimage=${InCdimage}`,
      );
      if (!Valid || !InCdimage) {
        // A bad catalog model must not leave the drop invisible - swap
        // to the placeholder prop and keep going. The catalog audit
        // surfaces the bad model for fixing.
        let Fallback = 0;
        try {
          Fallback = GetHashKey(PlaceholderGroundProp);
        } catch {
          // No fallback available; label-only drop.
        }
        if (Fallback === 0 || Entry.ModelHash === Fallback) {
          this.Log.Warn(`Prop model rejected drop=${Entry.DropID} hash=${Entry.ModelHash}`);
          return;
        }
        this.Log.Warn(
          `Prop model rejected drop=${Entry.DropID} hash=${Entry.ModelHash} - using placeholder`,
        );
        Entry.ModelHash = Fallback;
        // The catalog rotation is bound to the rejected model (a decal
        // plane laid flat); the placeholder is a normal upright prop.
        Entry.Rotation = null;
      }
    }
    if (Attempt > 40) {
      this.Log.Warn(`Ground drop prop load timed out drop=${Entry.DropID}`);
      return;
    }
    try {
      if (!HasModelLoaded(Entry.ModelHash)) {
        try {
          RequestModel(Entry.ModelHash);
        } catch {
          // Best-effort; retry path will catch it once loaded.
        }
        setTimeout((): void => this.SpawnPropWhenLoaded(Entry, Attempt + 1), 100);
        return;
      }
      const Object = CreateObject(
        Entry.ModelHash,
        Entry.X,
        Entry.Y,
        Entry.Z,
        false,
        false,
        false,
      );
      this.Log.Debug(
        `CreateObject drop=${Entry.DropID} entity=${Object} z=${Entry.Z.toFixed(3)} attempts=${Attempt}`,
      );
      if (typeof Object === 'number' && Object !== 0) {
        Entry.PropEntity = Object;
        try {
          // Catalog rotation before the freeze: decal-plane fixtures
          // (blood splat) are authored upright and must be laid flat;
          // everything else spawns at the engine default.
          if (Entry.Rotation !== null) {
            SetEntityRotation(
              Object,
              Entry.Rotation.Pitch,
              Entry.Rotation.Roll,
              Entry.Rotation.Yaw,
              2,
              true,
            );
            // The rotation spins the prop around its origin, and decal
            // geometry is authored offset from that origin, so the
            // now-flat plane hangs in the air over the drop coordinate
            // (verified in-game 2026-06-11). Re-anchor the lowest
            // rotated bounding-box corner onto the probed road
            // surface. Entry.Z (FootZ, pelvis minus 1.0m) is only the
            // probe-failed fallback - it can sit a hair under the
            // road, which would bury a flat plane. The +0.02 keeps the
            // plane off the surface against z-fighting.
            const MinZ = RotatedModelMinZ(Entry.ModelHash, Entry.Rotation);
            if (MinZ !== null) {
              let AnchorZ = Entry.Z;
              try {
                const [Found, GroundZ] = GetGroundZFor_3dCoord(
                  Entry.X,
                  Entry.Y,
                  Entry.Z + 1.0,
                  false,
                );
                if (Found) AnchorZ = GroundZ;
              } catch {
                // Probe unavailable - the FootZ fallback stands.
              }
              SetEntityCoordsNoOffset(
                Object,
                Entry.X,
                Entry.Y,
                AnchorZ - MinZ + 0.02,
                false,
                false,
                false,
              );
            }
          }
          // Freeze first, then drop collision entirely. keepPhysics
          // must be false: with it true some props keep a physical
          // hull that nudges peds and eats bullets - dropped items
          // must never block movement or gunfire.
          FreezeEntityPosition(Object, true);
          SetEntityCollision(Object, false, false);
        } catch {
          // Display-prop polish; the drop itself is server-side state.
        }
        try {
          SetModelAsNoLongerNeeded(Entry.ModelHash);
        } catch {
          // Best-effort.
        }
      } else {
        this.Log.Warn(`CreateObject returned 0 drop=${Entry.DropID}`);
      }
    } catch (Err: unknown) {
      this.Log.Warn(`Ground drop prop spawn failed`, { Err: String(Err) });
    }
  }

  /**
   * Remove a drop's prop and stop tracking it, when someone picks it up
   * or it ages out. Tolerates a drop whose prop never spawned.
   */
  private DespawnGroundDrop(DropID: string): void {
    const Entry = this.GroundDrops.get(DropID);
    if (Entry === undefined) return;
    this.GroundDrops.delete(DropID);
    if (Entry.PropEntity !== null) {
      const PropEntity = Entry.PropEntity;
      try {
        // The engine refuses DeleteEntity on non-mission entities;
        // claim ownership before deletion.
        SetEntityAsMissionEntity(PropEntity, true, true);
      } catch {
        // Best-effort; we still try the delete below.
      }
      let Deleted = false;
      try {
        DeleteEntity(PropEntity);
        Deleted = true;
      } catch {
        // Fallback to DeleteObject below.
      }
      if (!Deleted) {
        try {
          DeleteObject(PropEntity);
        } catch {
          // Object may already be gone (e.g., world reset).
        }
      }
      try {
        if (DoesEntityExist(PropEntity)) {
          this.Log.Warn(`Prop still exists after delete drop=${DropID} entity=${PropEntity}`);
        }
      } catch {
        // Best-effort diagnostic.
      }
    }
  }

  /**
   * Despawn every tracked drop. Runs on despawn and character switch -
   * without it the props would persist as orphans with no server row.
   */
  private DrainGroundDrops(): void {
    const IDs = Array.from(this.GroundDrops.keys());
    for (const ID of IDs) this.DespawnGroundDrop(ID);
  }

  /**
   * Begin the per-frame loop that draws floating labels over nearby
   * drops. Walks every tracked drop each frame, which is why the cull
   * inside it compares squared distance before taking a square root.
   */
  private StartLabelTick(): void {
    if (this.LabelTick !== null) return;
    this.LabelTick = setTick((): void => {
      if (!this.IsSpawned) return;
      if (this.GroundDrops.size === 0) return;
      const Ped = PlayerPedId();
      if (Ped === 0) return;
      // eslint-disable-next-line @typescript-eslint/naming-convention -- CitizenFX engine surface
      let Coords: { x: number; y: number; z: number } & [number, number, number];
      try {
        Coords = GetEntityCoords(Ped, true);
      } catch {
        return;
      }
      const Px = Number(Coords[0]);
      const Py = Number(Coords[1]);
      const Pz = Number(Coords[2]);
      if (!Number.isFinite(Px) || !Number.isFinite(Py) || !Number.isFinite(Pz)) return;
      // Cull on squared distance so the sqrt is only paid for the few
      // drops actually close enough to draw. This walks every drop the
      // server has spawned for us, every frame - a firefight leaves
      // casings, and a wounded player leaves up to thirty blood splats
      // each, so the culled majority is the common case.
      const HiddenRangeSq = LabelHiddenRangeMeters * LabelHiddenRangeMeters;
      for (const Entry of this.GroundDrops.values()) {
        const Dx = Entry.X - Px;
        const Dy = Entry.Y - Py;
        const Dz = Entry.Z - Pz;
        const DistanceSq = Dx * Dx + Dy * Dy + Dz * Dz;
        if (DistanceSq > HiddenRangeSq) continue;
        const Distance = Math.sqrt(DistanceSq);
        const Opacity =
          Distance <= LabelFullOpacityRangeMeters
            ? 1
            : Math.max(
                0,
                1 -
                  (Distance - LabelFullOpacityRangeMeters) /
                    (LabelHiddenRangeMeters - LabelFullOpacityRangeMeters),
              );
        const Alpha = Math.round(255 * Opacity);
        this.DrawLabel(Entry, Alpha);
      }
    });
  }

  /** Stop the label loop once no drops are tracked. */
  private StopLabelTick(): void {
    if (this.LabelTick === null) return;
    clearTick(this.LabelTick);
    this.LabelTick = null;
  }


  /**
   * Draw one drop's floating label, faded by distance.
   *
   * Clears the draw origin in a `finally` - an origin left set would
   * re-anchor every later 2D draw this frame to this drop's position.
   */
  private DrawLabel(Entry: GroundDropEntry, Alpha: number): void {
    try {
      SetDrawOrigin(Entry.X, Entry.Y, Entry.Z + 0.05, LabelDrawNetworkParam);
    } catch {
      // The origin never took - nothing drawn, nothing to clear.
      return;
    }
    try {
      SetTextScale(LabelTextScale, LabelTextScale);
      SetTextFontSafely(LabelTextFontSize);
      SetTextColour(255, 255, 255, Alpha);
      SetTextCentre(true);
      SetTextDropshadow(2, 0, 0, 0, Math.max(120, Alpha));
      SetTextOutline();
      BeginTextCommandDisplayText('RP_INV_LABEL');
      AddTextEntryStringArgSafely(Entry.Label);
      EndTextCommandDisplayText(0, 0);
    } catch {
      // Drawing can fail mid-resource-restart; treat as no-op.
    } finally {
      // MUST pair with the SetDrawOrigin above on every path. A draw
      // origin left set re-anchors every later 2D draw in this frame -
      // the nametag tower included, which renders from its own tick -
      // to this item's world position. That is the 0.3.0 "every tag
      // stacked at one far-off point" regression, and the text natives
      // above genuinely can throw (see the ...Safely wrappers).
      try {
        ClearDrawOrigin();
      } catch {
        // Nothing left to do; the frame ends and the origin resets.
      }
    }
  }
}

/**
 * Validate the replicated bag value into the local projection. The
 * wire shape is the Backend's `EquippedWeaponBag`; only the two fields
 * the poll consumes are checked - anything malformed reads as
 * unequipped.
 */
function NormaliseEquippedBag(Value: unknown): EquippedWeaponLocal | null {
  if (Value === null || Value === undefined || typeof Value !== 'object') return null;
  const Raw = Value as { WeaponHash?: unknown; LoadedAmmoTotal?: unknown };
  const WeaponHash = Number(Raw.WeaponHash);
  const LoadedAmmoTotal = Number(Raw.LoadedAmmoTotal);
  if (!Number.isFinite(WeaponHash) || !Number.isFinite(LoadedAmmoTotal)) return null;
  return { WeaponHash, LoadedAmmoTotal };
}

declare function SetTextFont(Font: number): void;
declare function AddTextComponentSubstringPlayerName(Body: string): void;

/*
 * ── Optional-native wrappers ─────────────────────────────────────────
 *
 * Text natives that are not guaranteed present on every client build.
 * Swallowing the error degrades the label to default styling instead of
 * throwing inside a per-frame draw loop, where one exception would kill
 * the tick and take every remaining drop label with it.
 */

/** Set the label font; falls back to the engine default if unavailable. */
function SetTextFontSafely(Font: number): void {
  try {
    SetTextFont(Font);
  } catch {
    // Native missing - fallback acceptable.
  }
}

/** Append the label body; no-ops if the native is unavailable. */
function AddTextEntryStringArgSafely(Body: string): void {
  try {
    AddTextComponentSubstringPlayerName(Body);
  } catch {
    // Native missing - fallback acceptable.
  }
}
