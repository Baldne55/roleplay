/**
 * ============================================================================
 * INVENTORY SERVICE - the authoritative owner of every item in the world
 * ============================================================================
 *
 * The largest service in the codebase, and the one with the strictest
 * correctness requirements: a bug here does not misdraw a nametag, it
 * duplicates or destroys player property. Read this header before
 * changing anything below it.
 *
 * WHAT IT OWNS
 * Character inventories, ground drops, container contents, weapon
 * equipping and discharge accounting, consumable use, and the mutation
 * audit trail behind `/aitem history|trace`. Paper cash is not special-
 * cased anywhere - currency is ordinary stackable items, which is why
 * CashService sums rows rather than reading a balance column.
 *
 * FOUR INVARIANTS, IN PRIORITY ORDER
 *
 * 1. Never destroy on a partial success. A mutation either fits or is
 *    refused; it must not place what fits and silently drop the rest.
 *    Callers that cannot tolerate a partial fill pass `AllOrNothing` and
 *    get an OverWeight/OutOfSlots outcome with nothing written.
 *
 * 2. One writer per inventory. Every mutation runs under
 *    `AsyncLock.Acquire(InventoryID)`, released in a `finally` with
 *    nothing that can throw in between. Cross-inventory operations
 *    (`/item give`, container moves) take both locks in ascending
 *    InventoryID order - a fixed order is the only thing preventing
 *    deadlock, since two players can give to each other simultaneously.
 *    See AcquireOrderedLocks, which must release the first lock if the
 *    second acquire times out.
 *
 * 3. Composites are transactional. A remove+add pair shares one
 *    Sequelize transaction and one TransactionID in the mutation log, so
 *    an item can never exist in both inventories or neither. The shared
 *    TransactionID is what `/aitem trace` reassembles.
 *
 * 4. The server's memory is the source of truth, never a state bag.
 *    `EquippedBags` holds the real equipped-weapon state; the replicated
 *    `EquippedWeapon` bag is a write-only mirror for client display. A
 *    modded client can rewrite the mirror and cannot reach the map, so
 *    every trusted read goes to the map.
 *
 * LAYERING - WHY EFFECTS ARE HANDED BACK, NOT APPLIED
 * This service deliberately does not hold CharacterRepository,
 * AlcoholService or AddictionService. Item use therefore returns the
 * *consequences* on its result object (`AlcoholEthanolGrams`, `DrugDose`,
 * `ApplyEffects`, `BleedingRelief`) and the command layer applies them.
 * That keeps the dependency graph acyclic; wiring those services in
 * directly would create a cycle through the character layer. Resist the
 * temptation - the awkward hand-off is load-bearing.
 *
 * ABUSE CONTROL
 * Two token buckets per Source, one for mutations and one for reads, plus
 * per-shot accounting windows feeding the anti-cheat layer. These are
 * rate limits on a trusted-server surface, not a substitute for
 * validation: every handler still re-checks ownership, range and state.
 *
 * FILE LAYOUT
 *   - Engine native declarations
 *   - Result/outcome interfaces (the shape every public method returns)
 *   - Internal state types
 *   - `class InventoryService` - ~65 public methods, ~39 private helpers
 *   - Free functions: metadata canonicalisation, serial helpers
 *
 * Outcomes are returned, not thrown. Every public method reports through
 * an `Outcome` discriminator with an optional human-readable `Detail`,
 * because the caller is usually a chat command that must explain the
 * refusal to a player.
 */
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { ChatFormatter } from '@Shared/Chat/Index.js';
import {
  AbsoluteStackQuantityCeiling,
  EquippedWeaponBagKey,
  FormatCashCents,
  InventoryMutationRateLimit,
  InventoryNetBroadcastRangeMeters,
  InventoryReadRateLimit,
  NearItemsRangeMeters,
  PickupRangeMeters,
  PlaceholderGroundProp,
  type InventoryMutationAction,
  type InventoryOutcome,
} from '@Shared/Constants/Inventory.js';
import {
  GetItemType,
  IsCatalogWeaponHash,
  IsCurrencyType,
  IsStackable,
  IsThrowableWeaponHash,
  ItemTypes,
  MetadataKeys,
  type AttachmentSlot,
  type ItemTypeDefinition,
} from '@Shared/Constants/ItemTypes.js';
import { EthanolGramsForDrink } from '@Shared/Constants/Alcohol.js';
import { PotencyFromMetadata, type DrugClass } from '@Shared/Constants/Drugs.js';
import {
  NormalizePhoneMetadata,
  PhoneMetadataKey,
  type PhoneMetadata,
} from '@Shared/Constants/Phone.js';
import { RegenTickIntervalMs } from '@Shared/Constants/Injury.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { DebugEnabled, Logger } from '@/Util/Logger.js';
import { Inventory } from '@/Data/Models/Inventory.js';
import { InventoryItem } from '@/Data/Models/InventoryItem.js';
import type { GroundDrop } from '@/Data/Models/GroundDrop.js';
import { FirstFreeSlot } from '@/Data/Repositories/InventoryRepository.js';
import type { InventoryRepository } from '@/Data/Repositories/InventoryRepository.js';
import type { InventoryMutationLogRepository } from '@/Data/Repositories/InventoryMutationLogRepository.js';
import type { GroundDropRepository } from '@/Data/Repositories/GroundDropRepository.js';
import type { WeaponDischargeLogRepository } from '@/Data/Repositories/WeaponDischargeLogRepository.js';
import type { ItemNameRequestRepository } from '@/Data/Repositories/ItemNameRequestRepository.js';
import type { ItemNameRequest, ItemNameRequestKind } from '@/Data/Models/ItemNameRequest.js';
import type { AsyncLock } from '@/Services/AsyncLock.js';
import type { IdentifierService } from '@/Services/IdentifierService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { CharacterRuntime } from '@/Services/CharacterRuntimeService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { ProximityNetBroadcaster } from '@/Services/ProximityNetBroadcaster.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';
import type { NametagActionService } from '@/Services/NametagActionService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetEntityHeading(Entity: number): number;
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;
declare function GetEntityHealth(Entity: number): number;
declare function GetPedArmour(Ped: number): number;
declare function SetPedArmour(Ped: number, Amount: number): void;
declare function Player(Source: number | string): {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};
/* eslint-enable @typescript-eslint/naming-convention */
// Weapon natives below are apiset-server in the FXServer manifest
// (runtime.fivem.net/doc/natives_cfx.json, verified 2026-06-10). They
// mutate the authoritative net state directly and replicate down - no
// client round-trip, so a modified client cannot keep a weapon the
// server revoked. NOTE: there is no apiset-server ammo *getter*; shot
// observation stays on the client's 25 ms poll.
declare function GiveWeaponToPed(
  Ped: number,
  WeaponHash: number,
  AmmoCount: number,
  IsHidden: boolean,
  ForceInHand: boolean,
): void;
declare function GiveWeaponComponentToPed(
  Ped: number,
  WeaponHash: number,
  ComponentHash: number,
): void;
declare function RemoveWeaponFromPed(Ped: number, WeaponHash: number): void;
declare function RemoveWeaponComponentFromPed(
  Ped: number,
  WeaponHash: number,
  ComponentHash: number,
): void;
declare function RemoveAllPedWeapons(Ped: number, P1: boolean): void;
declare function SetPedAmmo(Ped: number, WeaponHash: number, Ammo: number): void;
declare function SetCurrentPedWeapon(Ped: number, WeaponHash: number, ForceInHand: boolean): void;

/**
 * Outcome of an add.
 *
 * `AddedCount` and `OverflowCount` are the pair that matters: an `Ok`
 * outcome with a non-zero overflow means the add was *partial* - some
 * units did not fit. Callers that cannot tolerate that must pass
 * `AllOrNothing` rather than ignoring the overflow, because the units
 * counted there were never created and reporting plain success would be
 * telling the player they received items that do not exist.
 *
 * `TouchedSlots` lets the caller refresh only what changed instead of
 * re-reading the whole inventory.
 */
export interface InventoryAddResult {
  Outcome: InventoryOutcome;
  AddedCount?: number;
  OverflowCount?: number;
  TouchedSlots?: number[];
  Detail?: string;
}

/**
 * Outcome of a remove. `RemovedCount` can be lower than requested when
 * the stack held less than the caller asked for.
 */
export interface InventoryRemoveResult {
  Outcome: InventoryOutcome;
  RemovedCount?: number;
  Detail?: string;
}

/**
 * Outcome of a within-inventory move or split. `ToSlot` reports where the
 * items landed when the service chose the destination.
 */
export interface InventoryMoveResult {
  Outcome: InventoryOutcome;
  FromSlot?: number;
  ToSlot?: number;
  /** Units actually moved (a merge clamps at the target's MaxStack). */
  MovedCount?: number;
  Detail?: string;
}

/**
 * Outcome of using an item - the richest result type here, because "use"
 * covers eating, drinking, dosing, healing, and operating devices.
 *
 * Most fields are *instructions for the caller*, not things that already
 * happened. `AlcoholEthanolGrams`, `DrugDose`, `ApplyEffects` and
 * `BleedingRelief` are consequences the command layer must apply, because
 * this service deliberately does not depend on the services that own them
 * (see the file header on the acyclic-graph rule). Ignoring one silently
 * drops that half of the item's effect.
 *
 * The `BreathTest` / `SampleTest` / `IdPresent` flags mark device items
 * where nothing was consumed and the command layer still has work to do -
 * resolving a target, revealing metadata, stamping the cooldown only once
 * the target validates.
 */
export interface InventoryUseResult {
  Outcome: InventoryOutcome;
  ItemTypeID?: string;
  /** Narration body already floated above the head; informational for the caller. */
  Narration?: string;
  /** Per-Source toast text (already wrapped in ChatFormatter.Info by caller). */
  Reply?: string;
  /** Consumable HP / AP deltas for the caller to apply post-success. */
  ApplyEffects?: ConsumableEffects;
  /**
   * Ethanol grams of a consumed alcoholic drink. Handed off in the
   * command layer to AlcoholService.Ingest - same no-cycle rationale
   * as BleedingRelief (AlcoholService needs the character repository,
   * which this service deliberately does not hold).
   */
  AlcoholEthanolGrams?: number;
  /**
   * Addiction ledger hand-off for a consumed drug, applied in the
   * command layer via AddictionService.RecordDose (same layering
   * rationale as the alcohol grams).
   */
  DrugDose?: { Class: DrugClass; DoseScale: number };
  /**
   * The slot holds a breath-test device and the cooldown gate passed;
   * the command layer resolves the subject and performs the actual
   * reading. Nothing was consumed; the cooldown is stamped by the
   * command after the subject validates (gate-before-cost).
   */
  BreathTest?: true;
  /**
   * The slot holds a sample-analysis device (narcotics test kit). The
   * command layer resolves the target slot, reveals its hidden quality
   * / purity, and stamps the cooldown only on success. Nothing consumed.
   */
  SampleTest?: true;
  /**
   * The slot holds an identity document. The command layer resolves the
   * optional target player and presents the card. Nothing consumed.
   */
  IdPresent?: true;
  /** Serial (document number) of an IdPresent item; null when unminted. */
  CardSerial?: string | null;
  Detail?: string;
}

/**
 * Revealed narcotics readout for a tested drug slot. Surfaces the
 * normally-hidden potency metadata (Purity / THC / CBD) - the test kit
 * is the purpose-built device the hidden-key rule defers to. `NotTestable`
 * carries the item name so the command can explain the refusal.
 */
export interface SampleReadout {
  Outcome: 'Ok' | 'NotFound' | 'NotTestable';
  ItemName?: string;
  Quality?: string;
  Purity?: number;
  StrainType?: string;
  ThcPercent?: number;
  CbdPercent?: number;
}

/**
 * Consumable stat deltas, applied by `ApplyConsumableEffects` after a
 * successful UseItem: armour is a server-side read-modify-write
 * (GET_PED_ARMOUR / SET_PED_ARMOUR are apiset-server); HP has no
 * server-side setter, so the target is computed from the server-read
 * health and round-trips through InjuryApply as an absolute.
 */
export interface ConsumableEffects {
  HpDelta: number;
  ApDelta: number;
  /**
   * Bleeding-tier relief carried from the type's OnUseBleedingRelief.
   * Deliberately NOT applied by ApplyConsumableEffects: BleedingService
   * depends on InventoryService for evidence spawning, so the relief
   * hand-off lives in the command layer where both services are in
   * scope without a service-level cycle.
   */
  BleedingRelief?: 'StepDown' | 'Clear';
  /**
   * Over-time HP window carried from OnUseHpRegenPerSec /
   * OnUseEffectDurationSec (and the HP-class drug highs).
   * ApplyConsumableEffects opens the server-driven regen window; each
   * tick rides InjuryRegenTick as a relative delta.
   */
  RegenPerSec?: number;
  RegenDurationSec?: number;
  /**
   * Total-HP budget for the window. When set, the window stops once
   * this much has been offered even if ticks remain - the mechanism
   * that makes a cut batch deliver its potency-scaled amount rather
   * than rate x duration. Omitted (the medkit) the budget defaults
   * to the full rate x duration product.
   */
  RegenTotalHp?: number;
  /**
   * The stimulant comedown: this many seconds after the ApDelta
   * grant, whatever of the granted armour still stands drains back
   * out. Only the drug branch sets it - body armor's plates do not
   * evaporate.
   */
  ApDecayDelaySec?: number;
}

/**
 * Collect a consumable type's deltas: the immediate OnUseHpDelta /
 * OnUseApDelta pair, the bleeding-relief verb, and the over-time
 * regen window (OnUseHpRegenPerSec / OnUseEffectDurationSec).
 */
function BuildConsumableEffects(Type: ItemTypeDefinition): ConsumableEffects | undefined {
  const HpDelta = Type.OnUseHpDelta ?? 0;
  const ApDelta = Type.OnUseApDelta ?? 0;
  const BleedingRelief = Type.OnUseBleedingRelief;
  const RegenPerSec = Type.OnUseHpRegenPerSec ?? 0;
  const RegenDurationSec = Type.OnUseEffectDurationSec ?? 0;
  const HasRegen = RegenPerSec > 0 && RegenDurationSec > 0;
  if (HpDelta === 0 && ApDelta === 0 && BleedingRelief === undefined && !HasRegen) {
    return undefined;
  }
  return {
    HpDelta,
    ApDelta,
    ...(BleedingRelief !== undefined ? { BleedingRelief } : {}),
    ...(HasRegen ? { RegenPerSec, RegenDurationSec } : {}),
  };
}

/** Outcome of a cross-inventory move (`/item give`, container ops). */
export interface InventoryTransferResult {
  Outcome: InventoryOutcome;
  TransferredCount?: number;
  Detail?: string;
}

/**
 * Outcome of a drop. `DropID` is the world-drop handle other players use
 * to pick it up, and is what the client needs to spawn the prop.
 */
export interface InventoryDropResult {
  Outcome: InventoryOutcome;
  DropID?: string;
  ItemTypeID?: string;
  Detail?: string;
}

/** Outcome of a pickup. `PickedSlot` is 0-based, as everywhere internally. */
export interface InventoryPickupResult {
  Outcome: InventoryOutcome;
  ItemTypeID?: string;
  PickedSlot?: number;
  Detail?: string;
}

/**
 * Weapon-component drops carry their ComponentHash so the client can
 * resolve the prop model from the engine - the catalog stores no model
 * names for components.
 */
function ComponentModelFragment(
  Type: ItemTypeDefinition | undefined,
): { ComponentHash: number } | Record<string, never> {
  if (Type?.IsWeaponComponent === true && Type.ComponentHash !== undefined) {
    return { ComponentHash: Type.ComponentHash };
  }
  return {};
}

/**
 * Catalog types with a WorldObjectRotation (decal-plane fixtures like
 * the blood splat, authored upright) carry it in the spawn payload so
 * every client lays the prop flat instead of leaving the engine's
 * spawn rotation standing the plane on edge.
 */
function RotationFragment(
  Type: ItemTypeDefinition | undefined,
): { Rotation: { Pitch: number; Roll: number; Yaw: number } } | Record<string, never> {
  if (Type?.WorldObjectRotation !== undefined) {
    return { Rotation: { ...Type.WorldObjectRotation } };
  }
  return {};
}

/**
 * Sanitised outcome of a `/aitem testcatalog` round-trip. Arrays carry
 * only IDs that exist in the catalog; everything else from the wire is
 * dropped during sanitisation.
 *
 * The payload originates on a client, so every field passes through the
 * bounded/known-id helpers below before landing here - a modded client
 * must not be able to make an admin's audit report say anything it likes.
 */
export interface CatalogAuditResult {
  TimedOut: boolean;
  CheckedWeapons: number;
  CheckedComponents: number;
  ResolvedComponentModels: number;
  InvalidWeapons: string[];
  MissingWeapons: string[];
  ComponentRejections: { Component: string; Weapon: string }[];
  ClipSizeMismatches: { ID: string; Engine: number; Catalog: number }[];
  InvalidDropModels: string[];
}

/**
 * How long to wait for a client's catalog-audit reply before giving up
 * and returning a TimedOut result. The audit walks the whole weapon
 * catalog through engine natives client-side, so it is slow by nature -
 * this is generous on purpose, since a timeout reads as "audit failed"
 * to the admin who ran it.
 */
const CatalogAuditTimeoutMs = 20_000;
/**
 * Per-list cap on the returned findings. A catalog-wide mismatch would
 * otherwise return thousands of entries and blow out the chat render.
 *
 * Note the two caps do not compose cleanly: PushCappedList (the /aitem
 * testcatalog renderer) prints `Entries.length` as the headline count and
 * lists the first 15, but by then the array has already been truncated
 * here. So a run with more than 500 findings in one bucket reports
 * exactly "500" rather than the true total. Treat 500 as "at least 500"
 * and read the server log for the real figure.
 */
const CatalogAuditListCap = 500;

/**
 * The zero-value result, returned when an audit cannot run at all (no
 * client to ask, request refused). Distinct from a TimedOut result: this
 * one means nothing was checked, so every Checked* count is zero.
 */
const EmptyCatalogAuditResult: CatalogAuditResult = {
  TimedOut: false,
  CheckedWeapons: 0,
  CheckedComponents: 0,
  ResolvedComponentModels: 0,
  InvalidWeapons: [],
  MissingWeapons: [],
  ComponentRejections: [],
  ClipSizeMismatches: [],
  InvalidDropModels: [],
};

/*
 * ── Catalog-audit wire sanitisers ────────────────────────────────────
 *
 * The audit runs on a client (only the game engine can answer "does this
 * weapon hash resolve?"), so its report is hostile input. These four
 * helpers are the trust boundary: anything that is not a non-negative
 * integer, or not an id already present in the server's catalog, is
 * dropped rather than corrected. Lists are capped so a malicious client
 * cannot flood an admin's chat or the server log.
 */

/** Coerce to a sane non-negative integer, clamped well below any real count. */
function BoundedCount(Raw: unknown): number {
  const N = Number(Raw);
  if (!Number.isFinite(N) || !Number.isInteger(N) || N < 0) return 0;
  return Math.min(N, 100_000);
}

/** Keep only strings that name a real catalog item type. */
function KnownTypeIDList(Raw: unknown): string[] {
  if (!Array.isArray(Raw)) return [];
  return Raw.filter(
    (V): V is string => typeof V === 'string' && GetItemType(V) !== undefined,
  ).slice(0, CatalogAuditListCap);
}

/**
 * Keep only `{Component, Weapon}` pairs where *both* sides name a real
 * catalog type - a rejection naming an unknown id tells an admin nothing
 * and would just be the client inventing work.
 */
function KnownTypeIDPairList(Raw: unknown): { Component: string; Weapon: string }[] {
  if (!Array.isArray(Raw)) return [];
  const Out: { Component: string; Weapon: string }[] = [];
  for (const V of Raw) {
    if (Out.length >= CatalogAuditListCap) break;
    if (typeof V !== 'object' || V === null) continue;
    const Cast = V as { Component?: unknown; Weapon?: unknown };
    if (typeof Cast.Component !== 'string' || typeof Cast.Weapon !== 'string') continue;
    if (GetItemType(Cast.Component) === undefined || GetItemType(Cast.Weapon) === undefined) {
      continue;
    }
    Out.push({ Component: Cast.Component, Weapon: Cast.Weapon });
  }
  return Out;
}

/**
 * Keep clip-size comparisons for known types, bounding both counts.
 *
 * Note these are informational rather than failures - the catalog's
 * MaxAmmo is the server's reload cap, not a claim about the engine
 * default, so a mismatch here is expected. See RenderCatalogAudit.
 */
function ClipMismatchList(Raw: unknown): { ID: string; Engine: number; Catalog: number }[] {
  if (!Array.isArray(Raw)) return [];
  const Out: { ID: string; Engine: number; Catalog: number }[] = [];
  for (const V of Raw) {
    if (Out.length >= CatalogAuditListCap) break;
    if (typeof V !== 'object' || V === null) continue;
    const Cast = V as { ID?: unknown; Engine?: unknown; Catalog?: unknown };
    if (typeof Cast.ID !== 'string' || GetItemType(Cast.ID) === undefined) continue;
    Out.push({ ID: Cast.ID, Engine: BoundedCount(Cast.Engine), Catalog: BoundedCount(Cast.Catalog) });
  }
  return Out;
}

/**
 * Outcome of equipping a weapon. Everything past `Outcome` is what the
 * client needs to put the right gun in the ped's hands: the hash, its
 * fitted components, and the round count to load. `ItemRowID` and
 * `UniqueSerial` tie the equipped weapon back to the inventory row so
 * discharges can be attributed to a specific serial.
 */
export interface InventoryEquipResult {
  Outcome: InventoryOutcome;
  WeaponHash?: number;
  LoadedAmmoTotal?: number;
  ComponentHashes?: number[];
  ItemRowID?: string;
  UniqueSerial?: string | null;
  Detail?: string;
}

/**
 * Outcome of a reload. `Consumed` is how many rounds left the inventory,
 * `NewTotal` the magazine afterwards - both reported because a reload can
 * legitimately be partial when the player is low on ammunition.
 */
export interface InventoryReloadResult {
  Outcome: InventoryOutcome;
  WeaponHash?: number;
  NewTotal?: number;
  Consumed?: number;
  Detail?: string;
}

/**
 * Outcome of attaching or detaching a component. `DetachedSlot` is set on
 * the detach path only, naming the inventory slot the part returned to.
 */
export interface InventoryAttachResult {
  Outcome: InventoryOutcome;
  DetachedSlot?: number;
  Detail?: string;
}

/**
 * One ammo segment in a weapon's LoadedAmmo FIFO queue. Head = next
 * round fired; reload appends to the tail. Mixed types stay distinct
 * (segment 1 of FMJ, segment 2 of hollow points) so forensic reads
 * can identify which type fired the popped round.
 */
export interface LoadedAmmoSegment {
  ItemTypeID: string;
  Qty: number;
  CustomName?: string;
}

/**
 * One component fitted to a weapon, as stored in its metadata.
 *
 * Carries the originating item type as well as the engine hash so the
 * part can be reconstituted as a real inventory item on detach - a
 * fitted component is a stored item, not just a visual flag.
 */
export interface AttachedComponent {
  ItemTypeID: string;
  ComponentHash: number;
  AttachmentSlot: AttachmentSlot;
}

/** Replicated state-bag projection for the equipped-weapon read path. */
export interface EquippedWeaponBag {
  ItemRowID: string;
  WeaponHash: number;
  LoadedAmmoTotal: number;
  ComponentHashes: number[];
  UniqueSerial: string | null;
}

/**
 * Everything an add can be told beyond "what and how many": the item's
 * starting metadata, its audit attribution, whether it joins a caller's
 * transaction, and whether a partial fill is acceptable.
 */
export interface AddItemOptions {
  Metadata?: Record<string, unknown>;
  CustomName?: string;
  BoundCharacterID?: string;
  /** Caller for audit-log attribution. Source 0 / null = system action. */
  ActorSource?: number | null;
  ActorCharacterID?: string | null;
  ActorAccountID?: string | null;
  /** Audit-log reason free-text (system action description). */
  Reason?: string | null;
  /** Mutation type for the audit log. Defaults to 'Add'. */
  Action?: InventoryMutationAction;
  /**
   * When supplied, the AddItem path runs inside the caller's transaction
   * + lock window instead of opening its own. Used by Transfer / Pickup
   * to bundle Remove + Add into one atomic unit.
   */
  ExternalTransaction?: Transaction;
  ExternalLock?: boolean;
  TransactionID?: string;
  /**
   * Refuse the add outright unless EVERY unit fits. Composite callers
   * (Transfer / Pickup / container store + take) remove the full
   * quantity from the source BEFORE adding, so a partial add would
   * commit the shortfall out of existence. They set this flag; the
   * denial then arrives as a normal non-Ok outcome and their existing
   * rollback path undoes the source-side removal.
   *
   * Left unset, the add stays best-effort and reports the shortfall
   * through `OverflowCount` - the right shape for `/aitem give`, where
   * there is no source inventory to give the remainder back to.
   */
  AllOrNothing?: boolean;
}

/**
 * Audit and transaction plumbing for a remove. Mirrors the corresponding
 * fields on AddItemOptions so a composite operation can pass matching
 * attribution to both halves and have them share one TransactionID.
 */
export interface RemoveItemOptions {
  ActorSource?: number | null;
  ActorCharacterID?: string | null;
  ActorAccountID?: string | null;
  Reason?: string | null;
  Action?: InventoryMutationAction;
  ExternalTransaction?: Transaction;
  ExternalLock?: boolean;
  TransactionID?: string;
}

/** Per-(Source, ItemTypeID) cooldown entry. */
interface UseCooldownEntry {
  ExpiresAt: number;
}

/** Per-Source mutation rate-limit bucket (token bucket pattern). */
interface MutationRateBucket {
  Tokens: number;
  RefilledAt: number;
}

/**
 * Per-Source weapon-shot tracking. `LastShotAt` blocks the 25ms
 * inter-shot guard; `WindowStartedAt` + `WindowCount` enforce the
 * 25 shots/sec rolling cap. Both are evicted on
 * disconnect / character switch.
 */
interface WeaponShotState {
  LastShotAt: number;
  WindowStartedAt: number;
  WindowCount: number;
}

/**
 * Per-Source weapon-accounting detection state (Phase 1 anti-cheat).
 * Each detection accrues events into its own rolling window; a Report
 * fires when the window crosses its threshold and the window resets so
 * one sustained burst cannot double-report. `LastShotClaimMs` is the
 * liveness stamp of the client's 25 ms ammo poll - any WeaponShot
 * claim, accepted or rejected, refreshes it. Evicted on
 * disconnect / character switch alongside WeaponShotStates.
 */
interface ShotAccountingState {
  UnderflowWindowStartedAt: number;
  UnderflowCount: number;
  RejectionWindowStartedAt: number;
  RejectionCount: number;
  RapidFireSuppressedUntil: number;
  LastShotClaimMs: number | null;
  SilentDischargeWindowStartedAt: number;
  SilentDischargeCount: number;
}

/** Server-side `GetEntityCoords` on a ped returns pelvis-Z; subtract this to get foot-Z. */
const PedOriginToFeetMeters = 1.0;
/**
 * Floor between two accepted WeaponShot claims. Set at the client's own
 * poll interval, so it rejects claims that could not have come from an
 * honest client rather than trying to model a weapon's fire rate - the
 * fastest catalog weapon still sits well above this.
 */
const WeaponShotMinIntervalMs = 25;
/**
 * Rolling burst ceiling on top of the interval floor: 25 claims per
 * second. The floor alone permits 40/s, which a fully-automatic weapon
 * never sustains, so this catches a client pacing its claims just above
 * the floor to stay under it.
 */
const WeaponShotWindowMs = 1000;
const WeaponShotWindowMax = 25;
/** InfiniteAmmo: dry-fire underflows tolerated per rolling window before a Report. */
const InfiniteAmmoUnderflowThreshold = 3;
/**
 * Window the underflow threshold is counted over. A minute is long enough
 * that a genuine desync (one stale claim after a reload) ages out alone
 * instead of accumulating toward a report across an entire session.
 */
const InfiniteAmmoWindowMs = 60000;
/** RapidBulletFire: rate-limit rejections per rolling window before a Report. */
const RapidFireRejectionThreshold = 5;
/** Window the rejection threshold is counted over. */
const RapidFireWindowMs = 10000;
/**
 * Quiet period after a RapidBulletFire report. Longer than the window so
 * a cheat firing continuously scores once per suppression period rather
 * than re-reporting each time the window refills.
 */
const RapidFireReportSuppressMs = 30000;
/** ShotsUnreported: a discharge counts as silent when the last claim is older than this. */
const SilentDischargeMaxClaimAgeMs = 5000;
/**
 * Silent discharges tolerated per window before reporting. Above one
 * because a single unclaimed shot is an ordinary packet-loss artifact;
 * three inside a minute is a pattern.
 */
const SilentDischargeThreshold = 3;
/** Window the silent-discharge threshold is counted over. */
const SilentDischargeWindowMs = 60000;
/**
 * ShotsUnreported: liveness is judged this long AFTER the discharge, not
 * synchronously. The client's WeaponShot claim rides a 25 ms poll and so
 * lands a few milliseconds AFTER the damage event that triggered it; at
 * discharge time an honest claim legitimately still looks stale. An
 * honest claim arrives well inside this grace, so re-reading the live
 * stamp after it eliminates the per-lull false positive.
 */
const SilentDischargeGraceMs = 750;

/**
 * Inventory business logic. Single chokepoint for every mutation
 * against an `inventories` / `inventory_items` row. Every write runs
 * inside the per-InventoryID async lock + a Sequelize transaction
 * + an audit-log row appended in the same transaction.
 *
 * Phase 1 surface (see plan for the full set):
 *   - ApplyOnSpawn          : ensure inventory exists, re-grant permanents
 *   - GetInventoryForCharacter, ListItems
 *   - AddItem, RemoveItem, MoveItem, SplitStack
 *   - UseItem (Consumable branch)
 *
 * Phase 2+ extend this same service. The result objects mirror the
 * CommandResult shape so handlers can switch exhaustively.
 *
 * The per-Source mutation rate-limit (10/sec, token bucket) sits
 * upstream of the lock so a flood from one Source cannot starve the
 * AsyncLock queue. The per-(Source, ItemTypeID) use cooldown lives
 * inside the service so a `UseItem` cannot be spammed faster than the
 * item type permits.
 */
export class InventoryService {
  private readonly Log = Logger.New('Inventory');
  /** `${Source}:${ItemTypeID}` -> cooldown entry. */
  private readonly UseCooldowns = new Map<string, UseCooldownEntry>();
  /** Source -> mutation-rate token bucket. */
  private readonly MutationBuckets = new Map<number, MutationRateBucket>();
  /** Source -> read-rate token bucket. */
  private readonly ReadBuckets = new Map<number, MutationRateBucket>();
  /** Source -> weapon-shot guard state. */
  private readonly WeaponShotStates = new Map<number, WeaponShotState>();
  /** Source -> weapon-accounting detection windows (Phase 1 anti-cheat). */
  private readonly ShotAccounting = new Map<number, ShotAccountingState>();
  /**
   * Source -> equipped-weapon bag. Server-memory source of truth for
   * every trusted read (WeaponNotGranted, the held-weapon scanner,
   * HandleWeaponShot's row resolution). The replicated `EquippedWeapon`
   * state bag is a write-only mirror the Frontend reads for display /
   * OverMaxClip; a modded client can overwrite that mirror but cannot
   * reach this map. Evicted on disconnect / character switch.
   */
  private readonly EquippedBags = new Map<number, EquippedWeaponBag>();
  /**
   * CharacterID -> InventoryID for the per-shot hot path. An
   * inventory row is created once per character and its ID never
   * changes, so entries never go stale; the map grows by one entry
   * per distinct character seen since boot, which is negligible.
   */
  private readonly InventoryIDByCharacter = new Map<string, string>();
  /**
   * Source -> active consumable HP-regen window (the medkit's
   * over-time heal and the HP-class drug highs). One window per
   * source; a new use only takes the slot when it offers MORE
   * remaining healing than the active window - the per-type cooldown
   * prevents same-type stacking, and the keep-stronger rule prevents
   * a casual joint from silently discarding a medkit mid-flight.
   * TotalLeft is the HP budget still owed; the window closes when
   * either the ticks or the budget run out.
   */
  private readonly RegenWindows = new Map<
    number,
    { PerSec: number; TicksLeft: number; TotalLeft: number }
  >();
  /** Armed only while at least one regen window is live. */
  private RegenInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Source -> pending stimulant comedown. A second AP-class dose
   * before the first comedown fires merges into it (amounts add,
   * capped at the armour ceiling; the deadline resets to the fresh
   * dose's window) so stacked highs cannot leave permanently free
   * armour behind.
   */
  private readonly ApComedowns = new Map<
    number,
    { Amount: number; Handle: ReturnType<typeof setTimeout> }
  >();
  /**
   * Late-attached scanner hook (Bootstrap order: the anti-cheat
   * scanner trails the inventory cluster, same pattern as
   * InjuryService's heal sink). Every regen tick registers its
   * sanctioned HP rise so an open GodModeHealth hit window folds the
   * rise into its baseline instead of mistaking it for a heal - or,
   * worse, letting a cheater under fire pop a medkit to close the
   * window for free.
   */
  private HpAdjustmentSink: ((Source: number, HpDelta: number) => void) | null = null;
  /**
   * Late-attached scanner hook for server-AUTHORITATIVE armour
   * movement (Scanner.NoteServerCombinedFact). Separate from
   * HpAdjustmentSink because the two report different things: HP
   * ticks are client instructions a cheat can swallow (pending +
   * reconcile), while SET_PED_ARMOUR lands in the server's own read
   * unconditionally - it is a fact that shifts the GodModeHealth
   * baseline immediately. Routing armour through the pending path
   * would let a stimulant pop close every maturing window.
   */
  private ArmourFactSink: ((Source: number, CombinedDelta: number) => void) | null = null;
  constructor(
    private readonly Repo: InventoryRepository,
    private readonly MutationLog: InventoryMutationLogRepository,
    private readonly Identifiers: IdentifierService,
    private readonly Lock: AsyncLock,
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Chat: ChatService,
    private readonly Broadcaster: ProximityBroadcaster,
    private readonly Database: Sequelize,
    private readonly Ground: GroundDropRepository,
    private readonly DischargeLog: WeaponDischargeLogRepository,
    private readonly NetBroadcaster: ProximityNetBroadcaster,
    private readonly NameRequests: ItemNameRequestRepository,
    private readonly Anticheat: AnticheatService,
    private readonly NametagActions: NametagActionService,
  ) {
    void this.Identifiers;
    void this.Chat;
  }

  /**
   * Called from `CharacterController.SpawnInto` right after
   * `Runtimes.Attach`. Ensures the character's inventory row exists
   * and re-grants any `IsPermanent` types the character does not
   * already hold (decision 33). Phase 1 has no permanent types
   * declared - the loop is a no-op until Phase 4 ships
   * `license_driver` / `license_weapon`.
   */
  async ApplyOnSpawn(Source: number, Runtime: CharacterRuntime): Promise<void> {
    const Inv = await this.Repo.GetOrCreateForCharacter(Runtime.CharacterID);
    await this.RegrantPermanents(Source, Runtime.CharacterID, Inv);
    this.Log.Debug(
      `ApplyOnSpawn source=${Source} inventory=${Inv.ID} character=${Runtime.CharacterID}`,
    );
  }

  /**
   * The character's carried inventory, creating it if this is their first
   * time. Every command path starts here, so a character can never be
   * without one.
   */
  GetInventoryForCharacter(CharacterID: string): Promise<Inventory> {
    return this.Repo.GetOrCreateForCharacter(CharacterID);
  }

  /** Read an inventory's contents. No lock - callers that mutate take one. */
  ListItems(InventoryID: string): Promise<InventoryItem[]> {
    return this.Repo.LoadItems(InventoryID);
  }

  /** A single item row by id. */
  FindItemByID(ID: string): Promise<InventoryItem | null> {
    return this.Repo.FindItemByID(ID);
  }

  /**
   * Per-Source eviction. Cleans cooldown + rate-limit state on
   * disconnect / character switch so a future Source reuse starts
   * clean, and drains any mid-flight catalog audit: the armed 20 s
   * timeout would otherwise outlive the session and run
   * StripCatalogAuditLoadout (plus the stale OnResult) against a
   * recycled Source or the issuer's next character. The issuer IS the
   * evicted Source, so the aborted result is dropped, not delivered.
   */
  Evict(Source: number): void {
    this.MutationBuckets.delete(Source);
    this.ReadBuckets.delete(Source);
    this.WeaponShotStates.delete(Source);
    this.ShotAccounting.delete(Source);
    this.EquippedBags.delete(Source);
    this.RegenWindows.delete(Source);
    // Settle the comedown debt instead of merely cancelling it. The
    // persist path (CharacterController.PersistAndDetachRuntime) calls
    // Evict BEFORE reading the ped's armour for the row save, so
    // draining here keeps a relog or character switch mid-high from
    // banking the granted armour permanently - the exact bypass the
    // comedown exists to prevent.
    const Comedown = this.ApComedowns.get(Source);
    if (Comedown !== undefined) {
      clearTimeout(Comedown.Handle);
      this.ApComedowns.delete(Source);
      try {
        const Ped = GetPlayerPed(String(Source));
        if (Ped !== 0) {
          const RawArmour = GetPedArmour(Ped);
          const CurrentArmour = Number.isFinite(RawArmour) ? RawArmour : 0;
          const Drop = Math.min(Comedown.Amount, CurrentArmour);
          if (Drop > 0) {
            SetPedArmour(Ped, CurrentArmour - Drop);
            this.ArmourFactSink?.(Source, -Drop);
          }
        }
      } catch (Err: unknown) {
        this.Log.Warn(`Evict comedown settle failed source=${Source}`, { Err: String(Err) });
      }
    }
    const Prefix = `${Source}:`;
    for (const Key of this.UseCooldowns.keys()) {
      if (Key.startsWith(Prefix)) this.UseCooldowns.delete(Key);
    }
    const Audit = this.PendingCatalogAudits.get(Source);
    if (Audit !== undefined) {
      clearTimeout(Audit.Timeout);
      this.PendingCatalogAudits.delete(Source);
      this.Log.Info(`Catalog audit drained by eviction source=${Source}`);
    }
  }

  // ── Mutation primitives ─────────────────────────────────────────────

  /**
   * Add `Quantity` units of `ItemTypeID` to `InventoryID`. Merges into
   * matching stackable rows first (lowest slot first), then spills into
   * new slots up to SlotCapacity. Respects WeightCapacityGrams.
   *
   * Stackable merge requires (item_type_id + metadata_json + custom_name)
   * byte-for-byte equality; the canonical JSON serialiser sorts keys so
   * `{"A":1,"B":2}` and `{"B":2,"A":1}` both produce `{"A":1,"B":2}`.
   *
   * Identifier minting (decision 13) runs for each new row with
   * `SerialDomain` set; bound items also get `BoundCharacterID` stamped.
   * Stackables don't carry serials.
   *
   * Returns typed result; partial success (Add merged some, then ran
   * out of weight / slots) yields `Ok` with `AddedCount` < `Quantity`
   * and `OverflowCount` > 0.
   */
  async AddItem(
    InventoryID: string,
    ItemTypeID: string,
    Quantity: number,
    Options: AddItemOptions = {},
  ): Promise<InventoryAddResult> {
    const Type = GetItemType(ItemTypeID);
    if (Type === undefined) return { Outcome: 'UnknownItemType' };
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    if (Quantity > AbsoluteStackQuantityCeiling) return { Outcome: 'InvalidQuantity' };

    const RunBody = async (T: Transaction): Promise<InventoryAddResult> => {
      return await this.PerformAdd(InventoryID, Type, Quantity, Options, T);
    };

    if (Options.ExternalTransaction !== undefined) {
      // Caller already holds the lock + transaction; run the body
      // directly to keep the multi-step composite (Transfer, Pickup)
      // atomic.
      return await RunBody(Options.ExternalTransaction);
    }

    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const T = await this.Database.transaction();
      try {
        const Result = await RunBody(T);
        await T.commit();
        return Result;
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`AddItem transaction failed inventory=${InventoryID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * Remove `Quantity` units from `InventoryID:SlotIndex`. For a
   * stackable, decrement and recompute weight; on reaching 0, delete
   * the row. For a non-stackable, `Quantity` must equal 1 (or be
   * omitted) and the row is deleted outright.
   *
   * Returns `NotEnoughQuantity` when the stack is too small;
   * `NotFound` when the slot is empty.
   */
  async RemoveItem(
    InventoryID: string,
    SlotIndex: number,
    Quantity: number,
    Options: RemoveItemOptions = {},
  ): Promise<InventoryRemoveResult> {
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }

    const RunBody = async (T: Transaction): Promise<InventoryRemoveResult> => {
      return await this.PerformRemove(InventoryID, SlotIndex, Quantity, Options, T);
    };

    if (Options.ExternalTransaction !== undefined) {
      return await RunBody(Options.ExternalTransaction);
    }

    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const T = await this.Database.transaction();
      try {
        const Result = await RunBody(T);
        await T.commit();
        return Result;
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`RemoveItem transaction failed inventory=${InventoryID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * Move a row (or split out a partial stack) within the same
   * inventory. When `Quantity` is omitted or equal to the source
   * stack, the whole row moves; when smaller, the source decrements
   * and the destination merges (if the target slot already holds a
   * matching stackable) or creates a new row. A `Quantity` above the
   * source stack returns `NotEnoughQuantity`.
   */
  async MoveItem(
    InventoryID: string,
    FromSlot: number,
    ToSlot: number,
    Quantity?: number,
  ): Promise<InventoryMoveResult> {
    if (FromSlot === ToSlot) return { Outcome: 'InvalidQuantity', Detail: 'Same slot.' };
    if (
      Quantity !== undefined &&
      (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0)
    ) {
      return { Outcome: 'InvalidQuantity' };
    }
    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const Inv = await this.Repo.FindByID(InventoryID);
      if (Inv === null) return { Outcome: 'NotFound' };
      if (ToSlot < 0 || ToSlot >= Inv.SlotCapacity) {
        return { Outcome: 'OutOfSlots', Detail: 'Target slot is out of range.' };
      }
      const Items = await this.Repo.LoadItems(InventoryID);
      const Source = Items.find((R) => R.SlotIndex === FromSlot);
      if (Source === undefined) return { Outcome: 'NotFound' };
      const Target = Items.find((R) => R.SlotIndex === ToSlot);
      const Type = GetItemType(Source.ItemTypeID);
      if (Type === undefined) return { Outcome: 'UnknownItemType' };

      const SourceQty = Source.StackQuantity ?? 1;
      if (Quantity !== undefined && Quantity > SourceQty) {
        return { Outcome: 'NotEnoughQuantity', Detail: 'Not enough in that stack.' };
      }
      const Want = Quantity ?? SourceQty;
      // Partial implies a stackable holding at least two units; a
      // non-stackable row only ever moves whole.
      const Partial = Want < SourceQty;
      if (Partial && !IsStackable(Type)) {
        return { Outcome: 'InvalidQuantity', Detail: 'Item is not stackable.' };
      }

      const T = await this.Database.transaction();
      try {
        // Whole-row move into an empty target slot - the common path.
        if (Target === undefined && !Partial) {
          await this.Repo.SaveItem(Source.ID, { SlotIndex: ToSlot }, T);
          await this.MutationLog.Append(
            {
              Action: 'Move',
              TransactionID: randomUUID(),
              ItemTypeID: Source.ItemTypeID,
              Quantity: SourceQty,
              UniqueSerial: Source.UniqueSerial,
              FromInventoryID: InventoryID,
              FromSlotIndex: FromSlot,
              ToInventoryID: InventoryID,
              ToSlotIndex: ToSlot,
            },
            T,
          );
          await T.commit();
          return { Outcome: 'Ok', FromSlot, ToSlot, MovedCount: SourceQty };
        }

        // Partial into an empty target slot: decrement the source and
        // materialise the moved units as a new row.
        if (Target === undefined) {
          const NewSourceQty = SourceQty - Want;
          const NewSourceWeight = (Type.WeightGrams * NewSourceQty).toFixed(2);
          const SplitWeight = (Type.WeightGrams * Want).toFixed(2);
          await this.Repo.SaveItem(
            Source.ID,
            { StackQuantity: NewSourceQty, WeightGrams: NewSourceWeight },
            T,
          );
          await this.Repo.CreateItem(
            {
              InventoryID,
              SlotIndex: ToSlot,
              ItemTypeID: Source.ItemTypeID,
              StackQuantity: Want,
              WeightGrams: SplitWeight,
              MetadataJson: Source.MetadataJson,
              CustomName: Source.CustomName,
            },
            T,
          );
          await this.MutationLog.Append(
            {
              Action: 'Move',
              TransactionID: randomUUID(),
              ItemTypeID: Source.ItemTypeID,
              Quantity: Want,
              FromInventoryID: InventoryID,
              FromSlotIndex: FromSlot,
              ToInventoryID: InventoryID,
              ToSlotIndex: ToSlot,
              Reason: 'Split',
            },
            T,
          );
          await T.commit();
          return { Outcome: 'Ok', FromSlot, ToSlot, MovedCount: Want };
        }

        // Target occupied. If source is a stackable matching target
        // byte-for-byte, merge up to MaxStack; otherwise refuse.
        if (
          !IsStackable(Type) ||
          Source.ItemTypeID !== Target.ItemTypeID ||
          Source.MetadataJson !== Target.MetadataJson ||
          Source.CustomName !== Target.CustomName
        ) {
          await T.rollback();
          return { Outcome: 'SlotOccupied' };
        }

        const Have = Target.StackQuantity ?? 0;
        const Add = Math.min(Want, Type.MaxStack - Have);
        if (Add <= 0) {
          await T.rollback();
          return { Outcome: 'SlotOccupied' };
        }
        const NewTarget = Have + Add;
        const NewSource = SourceQty - Add;
        const TargetWeight = (Type.WeightGrams * NewTarget).toFixed(2);
        await this.Repo.SaveItem(
          Target.ID,
          { StackQuantity: NewTarget, WeightGrams: TargetWeight },
          T,
        );
        if (NewSource <= 0) {
          await this.Repo.DeleteItem(Source.ID, T);
        } else {
          const SourceWeight = (Type.WeightGrams * NewSource).toFixed(2);
          await this.Repo.SaveItem(
            Source.ID,
            { StackQuantity: NewSource, WeightGrams: SourceWeight },
            T,
          );
        }
        await this.MutationLog.Append(
          {
            Action: 'Move',
            TransactionID: randomUUID(),
            ItemTypeID: Source.ItemTypeID,
            Quantity: Add,
            FromInventoryID: InventoryID,
            FromSlotIndex: FromSlot,
            ToInventoryID: InventoryID,
            ToSlotIndex: ToSlot,
          },
          T,
        );
        await T.commit();
        return { Outcome: 'Ok', FromSlot, ToSlot, MovedCount: Add };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`MoveItem transaction failed inventory=${InventoryID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * Split `Quantity` units off `SlotIndex` into the next free slot.
   * Refuses on non-stackable or when the source has only one unit.
   */
  async SplitStack(
    InventoryID: string,
    SlotIndex: number,
    Quantity: number,
  ): Promise<InventoryMoveResult> {
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const Inv = await this.Repo.FindByID(InventoryID);
      if (Inv === null) return { Outcome: 'NotFound' };
      const Items = await this.Repo.LoadItems(InventoryID);
      const Source = Items.find((R) => R.SlotIndex === SlotIndex);
      if (Source === undefined) return { Outcome: 'NotFound' };
      const Type = GetItemType(Source.ItemTypeID);
      if (Type === undefined) return { Outcome: 'UnknownItemType' };
      if (!IsStackable(Type) || (Source.StackQuantity ?? 0) <= 1) {
        return { Outcome: 'InvalidQuantity', Detail: 'Item is not stackable.' };
      }
      if (Quantity >= (Source.StackQuantity ?? 0)) {
        return { Outcome: 'InvalidQuantity', Detail: 'Split quantity must be less than the stack.' };
      }
      const Free = await this.Repo.NextFreeSlot(InventoryID, Inv.SlotCapacity);
      if (Free === null) return { Outcome: 'OutOfSlots' };

      const T = await this.Database.transaction();
      try {
        const NewSource = (Source.StackQuantity ?? 0) - Quantity;
        const NewSourceWeight = (Type.WeightGrams * NewSource).toFixed(2);
        const NewSplitWeight = (Type.WeightGrams * Quantity).toFixed(2);
        await this.Repo.SaveItem(
          Source.ID,
          { StackQuantity: NewSource, WeightGrams: NewSourceWeight },
          T,
        );
        await this.Repo.CreateItem(
          {
            InventoryID,
            SlotIndex: Free,
            ItemTypeID: Source.ItemTypeID,
            StackQuantity: Quantity,
            WeightGrams: NewSplitWeight,
            MetadataJson: Source.MetadataJson,
            CustomName: Source.CustomName,
          },
          T,
        );
        await this.MutationLog.Append(
          {
            Action: 'Move',
            TransactionID: randomUUID(),
            ItemTypeID: Source.ItemTypeID,
            Quantity,
            FromInventoryID: InventoryID,
            FromSlotIndex: SlotIndex,
            ToInventoryID: InventoryID,
            ToSlotIndex: Free,
            Reason: 'Split',
          },
          T,
        );
        await T.commit();
        return { Outcome: 'Ok', FromSlot: SlotIndex, ToSlot: Free };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`SplitStack transaction failed inventory=${InventoryID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * `/useitem` - dispatch on the item's category. Phase 1 implements
   * the Consumable branch; other branches return `InvalidUse` until
   * later phases ship them.
   */
  async UseItem(Source: number, SlotIndex: number): Promise<InventoryUseResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied', Detail: 'You must be in the world to use items.' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Items = await this.Repo.LoadItems(Inv.ID);
    const Row = Items.find((R) => R.SlotIndex === SlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound', Detail: 'Slot is empty.' };
    const Type = GetItemType(Row.ItemTypeID);
    if (Type === undefined) return { Outcome: 'UnknownItemType' };

    // Container branch (decision 31). Opens / renders the inner
    // inventory; no mutation. The text manifest is built by the
    // command handler via GetContainerInventory, so the service just
    // confirms eligibility and returns the type ID.
    if (Type.IsContainer === true) {
      return {
        Outcome: 'Ok',
        ItemTypeID: Type.ID,
        Reply: ChatFormatter.Info(
          `Opening ${Type.DisplayName}. Use /inventory ${SlotIndex + 1} to read the contents.`,
        ),
      };
    }

    // Incapacitated characters cannot use items: recovery belongs to
    // the injury flow (medics, /revive), and a downed body chewing
    // through bandages - or narrating drug use and breath tests from
    // the ground - would route around it. The gate sits above every
    // consuming dispatch so a refused use never burns anything; the
    // read-only container branch above stays usable while downed,
    // consistent with /inventory remaining readable.
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime !== null && Runtime.InjuryStatus !== 'Healthy') {
      return { Outcome: 'InvalidUse', Detail: 'You cannot use items while incapacitated.' };
    }

    // Breath-test device. Nothing is consumed and no effect applies -
    // the service only certifies that the slot really holds a tester
    // and that no cooldown is pending; the command layer resolves the
    // subject, reads the BAC through AlcoholService, narrates, and
    // stamps the cooldown only once the subject validates - a typo'd
    // player ID must not burn the 5 s wait (same gate-before-cost
    // rule as the consumable branch).
    if (Type.IsBreathTester === true) {
      const Pending = this.PendingUseCooldown(Source, Type.ID);
      if (Pending !== null) return Pending;
      return { Outcome: 'Ok', ItemTypeID: Type.ID, BreathTest: true };
    }

    // Sample-analysis device (narcotics test kit). Like the breath
    // tester, nothing is consumed and the cooldown is deferred to the
    // command layer, which resolves the target slot, reveals the hidden
    // quality / purity, and only then stamps the wait - a typo'd target
    // never burns the kit's cooldown.
    if (Type.IsSampleTester === true) {
      const Pending = this.PendingUseCooldown(Source, Type.ID);
      if (Pending !== null) return Pending;
      return { Outcome: 'Ok', ItemTypeID: Type.ID, SampleTest: true };
    }

    // Identity document (ID card / licenses). Presenting reads the
    // card's serial; the command layer resolves the optional target
    // player (proximity-gated) and reveals the holder's identity. No
    // consumption; cooldown deferred like the breath tester.
    if (Type.IsIdentityDocument === true) {
      const Pending = this.PendingUseCooldown(Source, Type.ID);
      if (Pending !== null) return Pending;
      return {
        Outcome: 'Ok',
        ItemTypeID: Type.ID,
        IdPresent: true,
        CardSerial: Row.UniqueSerial,
      };
    }

    // Drug branch (decision 31). Vague narration - witnesses still
    // see only "uses something." - but the high is real now: a
    // potency-scaled stat movement plus the addiction hand-off. No
    // cosmetic effects by design. Cooldown stamps so the dispatch
    // cannot be spammed faster than the type permits. Consumes one
    // unit.
    if (Type.IsDrug === true) {
      const Cooldown = Type.OnUseCooldownMs ?? 5_000;
      const SpamKey = `${Source}:${Type.ID}`;
      const Now = Date.now();
      const Existing = this.UseCooldowns.get(SpamKey);
      if (Existing !== undefined && Existing.ExpiresAt > Now) {
        return {
          Outcome: 'OnCooldown',
          Detail: `Wait ${Math.ceil((Existing.ExpiresAt - Now) / 1000)} more second(s).`,
        };
      }
      // Potency reads the row's hidden Purity / THC BEFORE the
      // decrement - the consumed unit's batch is what hits the
      // bloodstream. AP-class highs carry their comedown delay; the
      // rest spread the amount across a regen window.
      let DrugEffects: ConsumableEffects | undefined;
      if (
        Type.OnUseBoostStat !== undefined &&
        Type.OnUseBoostAmount !== undefined &&
        Type.OnUseBoostDurationSec !== undefined &&
        Type.OnUseBoostDurationSec > 0
      ) {
        const Potency = PotencyFromMetadata(Row.MetadataJson);
        const Amount = Math.round(Type.OnUseBoostAmount * Potency);
        if (Amount > 0) {
          // HP-class highs run at the type's full-potency rate but
          // carry the potency-scaled amount as a hard budget - the
          // window simply ends early for a cut batch. Flooring the
          // rate alone would deliver rate x duration regardless of
          // potency, making garbage product heal like pure.
          DrugEffects =
            Type.OnUseBoostStat === 'AP'
              ? { HpDelta: 0, ApDelta: Amount, ApDecayDelaySec: Type.OnUseBoostDurationSec }
              : {
                  HpDelta: 0,
                  ApDelta: 0,
                  RegenPerSec: Math.max(
                    1,
                    Math.round(Type.OnUseBoostAmount / Type.OnUseBoostDurationSec),
                  ),
                  RegenDurationSec: Type.OnUseBoostDurationSec,
                  RegenTotalHp: Amount,
                };
        }
      }
      const RemoveResult = await this.RemoveItem(Inv.ID, SlotIndex, 1, {
        ActorSource: Source,
        ActorCharacterID: PlayerState.CharacterID,
        Reason: 'Use (drug)',
      });
      if (RemoveResult.Outcome !== 'Ok') {
        const Failure: InventoryUseResult = { Outcome: RemoveResult.Outcome };
        if (RemoveResult.Detail !== undefined) Failure.Detail = RemoveResult.Detail;
        return Failure;
      }
      this.UseCooldowns.set(SpamKey, { ExpiresAt: Now + Cooldown });
      // Floated above the head (the /ame channel) rather than
      // broadcast to chat - item interactions must not flood the
      // conversation (decision 2026-06-12).
      const Body = 'uses something.';
      this.NametagActions.SetAction(Source, Body);
      const DrugResult: InventoryUseResult = {
        Outcome: 'Ok',
        ItemTypeID: Type.ID,
        Narration: Body,
        Reply: ChatFormatter.Info(`You consume the ${Type.DisplayName.toLowerCase()}.`),
      };
      if (DrugEffects !== undefined) DrugResult.ApplyEffects = DrugEffects;
      if (Type.DrugClass !== undefined) {
        DrugResult.DrugDose = { Class: Type.DrugClass, DoseScale: 1 };
      }
      return DrugResult;
    }

    if (Type.IsConsumable !== true) {
      return { Outcome: 'InvalidUse', Detail: 'You cannot use that item.' };
    }

    // Per-(Source, ItemTypeID) cooldown - prevents bandage spam.
    const CooldownMs = Type.OnUseCooldownMs ?? 0;
    const Now = Date.now();
    const CooldownKey = `${Source}:${Type.ID}`;
    const Entry = this.UseCooldowns.get(CooldownKey);
    if (Entry !== undefined && Entry.ExpiresAt > Now) {
      return {
        Outcome: 'OnCooldown',
        Detail: `Wait ${Math.ceil((Entry.ExpiresAt - Now) / 1000)} more second(s).`,
      };
    }

    // Decrement / delete the row before emitting the HP / AP payload.
    const Remove = await this.RemoveItem(Inv.ID, SlotIndex, 1, {
      ActorSource: Source,
      ActorCharacterID: PlayerState.CharacterID,
      Reason: 'Use',
    });
    if (Remove.Outcome !== 'Ok') {
      const Failure: InventoryUseResult = { Outcome: Remove.Outcome };
      if (Remove.Detail !== undefined) Failure.Detail = Remove.Detail;
      return Failure;
    }

    if (CooldownMs > 0) this.UseCooldowns.set(CooldownKey, { ExpiresAt: Now + CooldownMs });

    if (Runtime === null) {
      return { Outcome: 'Ok', ItemTypeID: Type.ID };
    }

    // Collect the type's HP / AP deltas plus any over-time regen
    // window. The caller applies them post-success via
    // ApplyConsumableEffects (decision 30).
    const ApplyEffects = BuildConsumableEffects(Type);

    // Personal toast + IC narration, floated above the head (the
    // /ame channel) rather than broadcast to chat. Alcohol gets a
    // deliberately type-agnostic "takes a drink." narration so
    // witnesses see the drinking but not the bottle's label
    // (decision 31). Other consumables get the more specific
    // "uses a X." narration.
    const IsAlcohol = Type.AlcoholPercent !== undefined;
    const Reply = ChatFormatter.Info(
      IsAlcohol
        ? `You drink the ${Type.DisplayName.toLowerCase()}.`
        : `You used a ${Type.DisplayName}.`,
    );
    const NarrationBody = IsAlcohol
      ? 'takes a drink.'
      : `uses a ${Type.DisplayName.toLowerCase()}.`;
    this.NametagActions.SetAction(Source, NarrationBody);

    const Result: InventoryUseResult = {
      Outcome: 'Ok',
      ItemTypeID: Type.ID,
      Reply,
      Narration: NarrationBody,
    };
    if (ApplyEffects !== undefined) Result.ApplyEffects = ApplyEffects;
    if (Type.AlcoholPercent !== undefined) {
      // LiquidVolumeMl is the pour; WeightGrams includes the vessel
      // (migration 20260610000007 made drinks count their glass), so
      // falling back to it runs hot - every catalog drink declares the
      // volume explicitly.
      Result.AlcoholEthanolGrams = EthanolGramsForDrink(
        Type.LiquidVolumeMl ?? Type.WeightGrams,
        Type.AlcoholPercent,
      );
    }
    return Result;
  }

  // ── Cross-inventory transfers (decision 7) ─────────────────────────

  /**
   * Move `Quantity` units of `FromSlot` from one inventory to another.
   * Locks both inventories in ascending ID order to prevent deadlock
   * (decision 7) and runs the Remove + Add pair inside one transaction
   * so a mid-flight rollback leaves both sides untouched.
   *
   * `BoundCharacterID` on the destination side is inferred from the
   * target Character inventory; the receiving holder owns whatever
   * arrives. The audit trail records the Transfer action twice (once
   * per side) sharing a single `transaction_id` so `/aitemtrace`
   * surfaces the atomic group.
   */
  async TransferItem(
    FromInventoryID: string,
    FromSlot: number,
    ToInventoryID: string,
    Quantity: number,
    Options: {
      ActorSource?: number | null;
      ActorCharacterID?: string | null;
      ActorAccountID?: string | null;
      Reason?: string | null;
      TargetCharacterID?: string;
    } = {},
  ): Promise<InventoryTransferResult> {
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    if (FromInventoryID === ToInventoryID) {
      return { Outcome: 'InvalidQuantity', Detail: 'Same inventory.' };
    }

    const Locks = await this.AcquireOrderedLocks(FromInventoryID, ToInventoryID);
    const TransactionID = randomUUID();
    try {
      const T = await this.Database.transaction();
      try {
        const FromItems = await this.Repo.LoadItems(FromInventoryID);
        const Row = FromItems.find((R) => R.SlotIndex === FromSlot);
        if (Row === undefined) {
          await T.rollback();
          return { Outcome: 'NotFound' };
        }
        const Type = GetItemType(Row.ItemTypeID);
        if (Type === undefined) {
          await T.rollback();
          return { Outcome: 'UnknownItemType' };
        }
        if (Type.IsTradeable !== true) {
          await T.rollback();
          return { Outcome: 'NotTradeable' };
        }
        if (
          Options.ActorSource !== undefined &&
          Options.ActorSource !== null &&
          this.IsRowEquipped(Options.ActorSource, Row.ID)
        ) {
          await T.rollback();
          return { Outcome: 'InvalidUse', Detail: 'Unequip the weapon before giving it.' };
        }
        if (!IsStackable(Type) && Quantity !== 1) {
          await T.rollback();
          return { Outcome: 'InvalidQuantity' };
        }
        if (IsStackable(Type) && (Row.StackQuantity ?? 0) < Quantity) {
          await T.rollback();
          return { Outcome: 'NotEnoughQuantity' };
        }

        // Re-bind on transfer when the type opts in. License-style
        // bound items DO NOT rebind (their IsHolderRebindable stays
        // false); phone-style items DO so the receiving holder
        // becomes the displayed owner.
        const Metadata: Record<string, unknown> | undefined =
          Row.MetadataJson !== null ? (JSON.parse(Row.MetadataJson) as Record<string, unknown>) : undefined;
        const AddOptions: AddItemOptions = {
          ActorSource: Options.ActorSource ?? null,
          ActorCharacterID: Options.ActorCharacterID ?? null,
          ActorAccountID: Options.ActorAccountID ?? null,
          Reason: Options.Reason ?? null,
          Action: 'Transfer',
          ExternalTransaction: T,
          TransactionID,
          AllOrNothing: true,
        };
        if (Row.CustomName !== null) AddOptions.CustomName = Row.CustomName;
        if (Metadata !== undefined) AddOptions.Metadata = Metadata;
        if (
          Options.TargetCharacterID !== undefined &&
          (Type.IsHolderRebindable === true || Type.IsHolderBound === true)
        ) {
          AddOptions.BoundCharacterID = Options.TargetCharacterID;
        } else if (Row.BoundCharacterID !== null) {
          AddOptions.BoundCharacterID = Row.BoundCharacterID;
        }

        // Carry-side: subtract from origin first so the weight check on
        // the destination side reflects the post-remove state.
        const Removed = await this.PerformRemove(
          FromInventoryID,
          FromSlot,
          Quantity,
          {
            ActorSource: Options.ActorSource ?? null,
            ActorCharacterID: Options.ActorCharacterID ?? null,
            ActorAccountID: Options.ActorAccountID ?? null,
            Reason: Options.Reason ?? null,
            Action: 'Transfer',
            TransactionID,
          },
          T,
        );
        if (Removed.Outcome !== 'Ok') {
          await T.rollback();
          return { Outcome: Removed.Outcome };
        }
        const Added = await this.PerformAdd(ToInventoryID, Type, Quantity, AddOptions, T);
        if (Added.Outcome !== 'Ok') {
          await T.rollback();
          return {
            Outcome: Added.Outcome,
            ...(Added.Detail !== undefined ? { Detail: Added.Detail } : {}),
          };
        }
        // For non-stackable single-row transfers, also carry the unique
        // serial across by copying onto the newly created row. The
        // PerformAdd path mints a fresh serial when SerialDomain is set;
        // we re-stamp it to the original after the fact so identity is
        // preserved across the transfer.
        //
        // A NULL source serial must be carried across too. Null is not
        // "no serial to copy", it is the defaced state /aitem
        // removeserial produces - leaving the freshly minted serial in
        // place would re-serialise a filed-off weapon on every
        // handover, undoing the defacement and inventing a serial with
        // no discharge history behind it.
        if (!IsStackable(Type) && Type.SerialDomain !== undefined) {
          const NewSlot = (Added.TouchedSlots ?? [])[0];
          if (NewSlot !== undefined) {
            const ToItems = await this.Repo.LoadItems(ToInventoryID);
            const NewRow = ToItems.find((R) => R.SlotIndex === NewSlot);
            if (NewRow !== undefined) {
              // Direct save to overwrite the freshly minted serial with
              // the original. PerformAdd already minted a unique-on-the-
              // wire candidate; overwriting it is safe because we held
              // the FROM and TO locks and the destination row was just
              // created in this transaction.
              await InventoryItem.update(
                { UniqueSerial: Row.UniqueSerial },
                { where: { ID: NewRow.ID }, transaction: T },
              );
            }
          }
        }
        await T.commit();
        return { Outcome: 'Ok', TransferredCount: Quantity };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(
          `TransferItem failed from=${FromInventoryID} to=${ToInventoryID}`,
          { Err: String(Err) },
        );
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      for (const Release of Locks) Release();
    }
  }

  /**
   * Debit `Cents` of currency from one inventory as a single atomic
   * composite, mirroring TransferItem: one lock acquisition, one
   * transaction, one TransactionID across every row touched. The
   * caller-facing alternative - walking rows through individual
   * RemoveItem calls - commits each row independently, so a player
   * mutation interleaving mid-walk (/item drop / give / split on a
   * cash row) could fail a later step while earlier debits stayed
   * committed: a failed debit that still cost the player money.
   * Here any failure rolls the whole walk back and costs nothing.
   *
   * The plan runs largest denomination down in whole units (exact
   * for canonical denomination sets) and is computed from rows read
   * under the lock, which makes it the authoritative
   * NotEnoughQuantity gate - a lock-free total precheck would both
   * race concurrent spends and pass on sums that whole units cannot
   * actually compose.
   */
  async RemoveCurrency(
    InventoryID: string,
    Cents: number,
    Options: RemoveItemOptions = {},
  ): Promise<InventoryRemoveResult> {
    if (!Number.isFinite(Cents) || !Number.isInteger(Cents) || Cents <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }

    const Release = await this.Lock.Acquire(InventoryID);
    const TransactionID = Options.TransactionID ?? randomUUID();
    try {
      const T = await this.Database.transaction();
      try {
        const ValuePerUnit = (TypeID: string): number =>
          GetItemType(TypeID)?.CurrencyValuePerUnit ?? 1;
        const Items = await this.Repo.LoadItems(InventoryID);
        const CashRows = Items.filter((Row) => IsCurrencyType(Row.ItemTypeID)).sort(
          (A, B) =>
            ValuePerUnit(B.ItemTypeID) - ValuePerUnit(A.ItemTypeID) ||
            A.SlotIndex - B.SlotIndex,
        );

        const Plan: { SlotIndex: number; Take: number; Value: number }[] = [];
        let Remaining = Cents;
        for (const Row of CashRows) {
          if (Remaining <= 0) break;
          const Value = ValuePerUnit(Row.ItemTypeID);
          const Take = Math.min(Row.StackQuantity ?? 0, Math.floor(Remaining / Value));
          if (Take <= 0) continue;
          Plan.push({ SlotIndex: Row.SlotIndex, Take, Value });
          Remaining -= Take * Value;
        }
        if (Remaining > 0) {
          await T.rollback();
          return { Outcome: 'NotEnoughQuantity' };
        }

        // One plan entry per row, never two takes from the same slot:
        // PerformRemove reads the committed snapshot (its row load does
        // not ride T), so within one transaction a revisited slot would
        // see its pre-debit quantity. Distinct slots keep every step's
        // view accurate, and the lock excludes all other writers.
        let Debited = 0;
        for (const Step of Plan) {
          const Result = await this.PerformRemove(
            InventoryID,
            Step.SlotIndex,
            Step.Take,
            { ...Options, TransactionID },
            T,
          );
          if (Result.Outcome !== 'Ok') {
            await T.rollback();
            return { Outcome: Result.Outcome, RemovedCount: 0 };
          }
          Debited += Step.Take * Step.Value;
        }
        await T.commit();
        return { Outcome: 'Ok', RemovedCount: Debited };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`RemoveCurrency failed inventory=${InventoryID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  // ── Ground drops (decision 24, B1, B8) ─────────────────────────────

  /**
   * Drop `Quantity` units of `SlotIndex` to the ground at the player's
   * ped coord. Server re-reads coords - client coords are advisory
   * only.
   */
  async DropToGround(
    Source: number,
    SlotIndex: number,
    Quantity: number,
  ): Promise<InventoryDropResult> {
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const RawCoord = this.ReadPedCoord(Source);
    if (RawCoord === null) return { Outcome: 'NotFound', Detail: 'No ped to drop from.' };
    // Server-side GetEntityCoords returns the ped's origin which is at
    // pelvis height (~1.0m above the feet). Drop coords + label render
    // must sit at the actual ground; subtract the offset before
    // persisting so every consumer treats it as foot-level.
    const Coord = { ...RawCoord, Z: RawCoord.Z - PedOriginToFeetMeters };

    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const Items = await this.Repo.LoadItems(Inv.ID);
      const Row = Items.find((R) => R.SlotIndex === SlotIndex);
      if (Row === undefined) return { Outcome: 'NotFound', Detail: 'Slot is empty.' };
      const Type = GetItemType(Row.ItemTypeID);
      if (Type === undefined) return { Outcome: 'UnknownItemType' };
      if (Type.IsDroppable === false) return { Outcome: 'NotDroppable' };
      if (this.IsRowEquipped(Source, Row.ID)) {
        return { Outcome: 'InvalidUse', Detail: 'Unequip the weapon before dropping it.' };
      }
      if (!IsStackable(Type) && Quantity !== 1) return { Outcome: 'InvalidQuantity' };
      if (IsStackable(Type) && (Row.StackQuantity ?? 0) < Quantity) {
        return { Outcome: 'NotEnoughQuantity' };
      }

      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        const DropWeight = (Type.WeightGrams * Quantity).toFixed(2);
        const Now = new Date();
        // For non-stackable singletons the row carries its identity
        // wholesale; for stackable partials the drop carries only the
        // dropped quantity worth of metadata (Quality / Purity / etc.
        // travel because they ride the metadata blob - the row is the
        // identity).
        const Drop = await this.Ground.Create(
          {
            ItemTypeID: Row.ItemTypeID,
            StackQuantity: IsStackable(Type) ? Quantity : null,
            WeightGrams: DropWeight,
            MetadataJson: Row.MetadataJson,
            CustomName: Row.CustomName,
            UniqueSerial: !IsStackable(Type) ? Row.UniqueSerial : null,
            BoundCharacterID: Row.BoundCharacterID,
            DroppedByCharacterID: PlayerState.CharacterID,
            ContainerInventoryID: Row.ContainerInventoryID,
            World: Coord.World,
            PositionX: Coord.X.toFixed(3),
            PositionY: Coord.Y.toFixed(3),
            PositionZ: Coord.Z.toFixed(3),
            DroppedAt: Now,
          },
          T,
        );
        // For non-stackable rows that carry a unique serial, null the
        // serial on the inventory row before deletion so the unique
        // index is free for the ground-drop row to claim it.
        if (!IsStackable(Type) && Row.UniqueSerial !== null) {
          await InventoryItem.update(
            { UniqueSerial: null },
            { where: { ID: Row.ID }, transaction: T },
          );
        }
        const Removed = await this.PerformRemove(
          Inv.ID,
          SlotIndex,
          Quantity,
          {
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            Reason: 'Drop',
            Action: 'Drop',
            TransactionID,
          },
          T,
        );
        if (Removed.Outcome !== 'Ok') {
          await T.rollback();
          return { Outcome: Removed.Outcome };
        }
        await T.commit();

        // Past the commit the drop is durable, so painting the prop is
        // best-effort and gets its own catch. Letting it fall through to
        // the outer handler would call rollback() on a committed
        // transaction - which throws "cannot be rolled back", escapes as
        // an unhandled rejection, and replaces the real error before it
        // is ever logged.
        try {
          // The label carries DropID + quantity but never the serial or
          // visible metadata (decision 24 B8).
          const Label = this.BuildGroundLabel(Drop, Type);
          const Model = Type.WorldObjectModel ?? PlaceholderGroundProp;
          this.NetBroadcaster.EmitInRange(
            NetEvents.InventoryGroundDropSpawn,
            {
              DropID: String(Drop.ID),
              X: Coord.X,
              Y: Coord.Y,
              Z: Coord.Z,
              World: Coord.World,
              Label,
              Model,
              ...ComponentModelFragment(Type),
              ...RotationFragment(Type),
            },
            { X: Coord.X, Y: Coord.Y, Z: Coord.Z },
            InventoryNetBroadcastRangeMeters,
            Coord.World,
          );
        } catch (Err: unknown) {
          this.Log.Error(`DropToGround prop spawn failed source=${Source}`, { Err: String(Err) });
        }
        return { Outcome: 'Ok', DropID: String(Drop.ID), ItemTypeID: Type.ID };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`DropToGround failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * `/item nearby` / `/item examine` listing. Returns the drops
   * within `NearItemsRangeMeters` of the player, sorted
   * nearest-first. Stateless: consumers address drops by their global
   * DropID (surfaced as `#<ID>` in the listing), never by list
   * position.
   */
  async ListNearGround(Source: number): Promise<{
    Outcome: InventoryOutcome;
    Drops?: { Drop: GroundDrop; DistanceMeters: number; Label: string }[];
  }> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned') {
      return { Outcome: 'PermissionDenied' };
    }
    const Coord = this.ReadPedCoord(Source);
    if (Coord === null) return { Outcome: 'NotFound' };
    const Drops = await this.Ground.FindInRadius(
      Coord.World,
      Coord.X,
      Coord.Y,
      Coord.Z,
      NearItemsRangeMeters,
    );
    const Decorated = Drops.map((Drop) => {
      const Dx = Number.parseFloat(Drop.PositionX) - Coord.X;
      const Dy = Number.parseFloat(Drop.PositionY) - Coord.Y;
      const Dz = Number.parseFloat(Drop.PositionZ) - Coord.Z;
      const Distance = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
      const Type = GetItemType(Drop.ItemTypeID);
      const Label = this.BuildGroundLabel(Drop, Type);
      return { Drop, DistanceMeters: Distance, Label };
    }).sort((A, B) => A.DistanceMeters - B.DistanceMeters);
    return { Outcome: 'Ok', Drops: Decorated };
  }

  /**
   * Emit `GroundDropSpawn` to a single source for every ground drop
   * within `InventoryNetBroadcastRangeMeters`. Used on player spawn /
   * resource restart so persisted drops appear without waiting for a
   * fresh drop event.
   */
  async ResyncGroundDropsToSource(Source: number): Promise<void> {
    const Coord = this.ReadPedCoord(Source);
    if (Coord === null) {
      this.Log.Info(`ResyncGroundDrops: no ped coord source=${Source}`);
      return;
    }
    const Drops = await this.Ground.FindInRadius(
      Coord.World,
      Coord.X,
      Coord.Y,
      Coord.Z,
      InventoryNetBroadcastRangeMeters,
    );
    this.Log.Info(`ResyncGroundDrops source=${Source} count=${Drops.length}`);
    for (const Drop of Drops) {
      const Type = GetItemType(Drop.ItemTypeID);
      const Label = this.BuildGroundLabel(Drop, Type);
      const Model = Type?.WorldObjectModel ?? PlaceholderGroundProp;
      this.NetBroadcaster.EmitToSource(Source, NetEvents.InventoryGroundDropSpawn, {
        DropID: String(Drop.ID),
        X: Number.parseFloat(Drop.PositionX),
        Y: Number.parseFloat(Drop.PositionY),
        Z: Number.parseFloat(Drop.PositionZ),
        World: Drop.World,
        Label,
        Model,
        ...ComponentModelFragment(Type),
        ...RotationFragment(Type),
      });
    }
  }

  /**
   * Pick up a drop by DropID. Race-safe via the `dropped_at`
   * fingerprint - only one of N concurrent pickers wins. The picked
   * row materialises in the picker's inventory with its identity
   * (serial, holder bind, container inner inventory) intact.
   */
  async PickupDrop(Source: number, DropID: string): Promise<InventoryPickupResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Drop = await this.Ground.FindByID(DropID);
    if (Drop === null) return { Outcome: 'NotFound', Detail: 'That drop is no longer there.' };
    // World-anchored evidence (blood splats) renders as a prop but is
    // not collectable; only the age sweep or staff tooling removes it.
    if (GetItemType(Drop.ItemTypeID)?.IsFixture === true) {
      return { Outcome: 'PermissionDenied', Detail: 'You cannot pick this up.' };
    }

    const Coord = this.ReadPedCoord(Source);
    if (Coord !== null) {
      if (Drop.World !== Coord.World) {
        return { Outcome: 'NotFound', Detail: 'That drop is in a different world.' };
      }
      const Dx = Number.parseFloat(Drop.PositionX) - Coord.X;
      const Dy = Number.parseFloat(Drop.PositionY) - Coord.Y;
      const Dz = Number.parseFloat(Drop.PositionZ) - Coord.Z;
      if (Dx * Dx + Dy * Dy + Dz * Dz > PickupRangeMeters * PickupRangeMeters) {
        return { Outcome: 'NotFound', Detail: 'That drop is out of reach.' };
      }
    }

    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        const Deleted = await this.Ground.DeleteWithFingerprint(DropID, Drop.DroppedAt, T);
        if (Deleted !== 1) {
          await T.rollback();
          return { Outcome: 'NotFound', Detail: 'That drop is no longer there.' };
        }
        const Type = GetItemType(Drop.ItemTypeID);
        if (Type === undefined) {
          await T.rollback();
          return { Outcome: 'UnknownItemType' };
        }
        const Quantity = Drop.StackQuantity ?? 1;
        const Metadata =
          Drop.MetadataJson !== null ? (JSON.parse(Drop.MetadataJson) as Record<string, unknown>) : undefined;
        const AddOptions: AddItemOptions = {
          ActorSource: Source,
          ActorCharacterID: PlayerState.CharacterID,
          Reason: 'Pickup',
          Action: 'Pickup',
          ExternalTransaction: T,
          TransactionID,
          AllOrNothing: true,
        };
        if (Drop.CustomName !== null) AddOptions.CustomName = Drop.CustomName;
        if (Metadata !== undefined) AddOptions.Metadata = Metadata;
        if (Drop.BoundCharacterID !== null) AddOptions.BoundCharacterID = Drop.BoundCharacterID;

        const Added = await this.PerformAdd(Inv.ID, Type, Quantity, AddOptions, T);
        if (Added.Outcome !== 'Ok') {
          await T.rollback();
          return {
            Outcome: Added.Outcome,
            ...(Added.Detail !== undefined ? { Detail: Added.Detail } : {}),
          };
        }
        // Re-stamp the serial / container inner inventory on the new
        // row(s) - PerformAdd will have minted a fresh serial if the
        // type has SerialDomain, but we want to preserve the dropped
        // row's identity verbatim.
        if (!IsStackable(Type)) {
          const TouchedSlot = (Added.TouchedSlots ?? [])[0];
          if (TouchedSlot !== undefined) {
            const Items = await this.Repo.LoadItems(Inv.ID);
            const NewRow = Items.find((R) => R.SlotIndex === TouchedSlot);
            if (NewRow !== undefined) {
              const Patch: { UniqueSerial?: string | null; ContainerInventoryID?: string | null } = {};
              // Serial-bearing types re-stamp unconditionally, null
              // included: a defaced weapon left on the ground must not
              // come back off it wearing a freshly minted serial.
              if (Type.SerialDomain !== undefined) Patch.UniqueSerial = Drop.UniqueSerial;
              if (Drop.ContainerInventoryID !== null) {
                Patch.ContainerInventoryID = Drop.ContainerInventoryID;
              }
              if (Object.keys(Patch).length > 0) {
                await InventoryItem.update(Patch, { where: { ID: NewRow.ID }, transaction: T });
              }
            }
          }
        }
        await T.commit();
        // Best-effort past the commit - see DropToGround: a throw here
        // must not reach the outer catch and roll back a committed
        // transaction.
        try {
          // Notify everyone in proximity the prop is gone.
          this.NetBroadcaster.EmitInRange(
            NetEvents.InventoryGroundDropDespawn,
            { DropID },
            {
              X: Number.parseFloat(Drop.PositionX),
              Y: Number.parseFloat(Drop.PositionY),
              Z: Number.parseFloat(Drop.PositionZ),
            },
            InventoryNetBroadcastRangeMeters,
            Drop.World,
          );
        } catch (Err: unknown) {
          this.Log.Error(`PickupDrop despawn broadcast failed source=${Source}`, {
            Err: String(Err),
          });
        }
        return {
          Outcome: 'Ok',
          ItemTypeID: Type.ID,
          ...((Added.TouchedSlots ?? [])[0] !== undefined
            ? { PickedSlot: (Added.TouchedSlots ?? [])[0] }
            : {}),
        };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`PickupDrop failed source=${Source} drop=${DropID}`, {
          Err: String(Err),
        });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /** Staff sweep. Deletes every drop in the radius and despawns props. */
  async ClearDropsInRadius(
    World: number,
    X: number,
    Y: number,
    Z: number,
    RadiusMeters: number,
  ): Promise<number> {
    const Cleared = await this.Ground.DeleteInRadius(World, X, Y, Z, RadiusMeters);
    for (const Drop of Cleared) {
      this.NetBroadcaster.EmitInRange(
        NetEvents.InventoryGroundDropDespawn,
        { DropID: String(Drop.ID) },
        {
          X: Number.parseFloat(Drop.PositionX),
          Y: Number.parseFloat(Drop.PositionY),
          Z: Number.parseFloat(Drop.PositionZ),
        },
        InventoryNetBroadcastRangeMeters,
        Drop.World,
      );
    }
    return Cleared.length;
  }

  /**
   * System despawn of a single ground drop (bleeding tier changes,
   * future decay paths). Unlike pickup there is no inventory to
   * credit, but the delete still goes through the `dropped_at`
   * fingerprint so a concurrent player pickup cleanly wins the race
   * instead of double-despawning the prop. Returns true when this
   * call deleted the row.
   */
  async RemoveGroundDropBySystem(DropID: string): Promise<boolean> {
    try {
      const Drop = await this.Ground.FindByID(DropID);
      if (Drop === null) return false;
      const Deleted = await this.Ground.DeleteWithFingerprint(DropID, Drop.DroppedAt);
      if (Deleted !== 1) return false;
      this.NetBroadcaster.EmitInRange(
        NetEvents.InventoryGroundDropDespawn,
        { DropID: String(Drop.ID) },
        {
          X: Number.parseFloat(Drop.PositionX),
          Y: Number.parseFloat(Drop.PositionY),
          Z: Number.parseFloat(Drop.PositionZ),
        },
        InventoryNetBroadcastRangeMeters,
        Drop.World,
      );
      return true;
    } catch (Err: unknown) {
      this.Log.Warn(`RemoveGroundDropBySystem failed drop=${DropID}`, { Err: String(Err) });
      return false;
    }
  }

  /**
   * Age sweep for system evidence drops: delete and despawn-broadcast
   * every drop of `ItemTypeID` older than `MaxAgeMs`. The owning
   * system drives the cadence (BleedingService sweeps blood splats on
   * its own timer); the inventory layer owns only the row and prop
   * lifecycle. Returns the swept count.
   */
  async SweepEvidenceDrops(ItemTypeID: string, MaxAgeMs: number): Promise<number> {
    const Before = new Date(Date.now() - MaxAgeMs);
    let Swept = 0;
    try {
      const Rows = await this.Ground.FindByTypeOlderThan(ItemTypeID, Before);
      for (const Drop of Rows) {
        const Deleted = await this.Ground.DeleteWithFingerprint(String(Drop.ID), Drop.DroppedAt);
        // A concurrent pickup or staff clear won the race; whoever
        // deleted the row also broadcast the despawn.
        if (Deleted !== 1) continue;
        Swept += 1;
        this.NetBroadcaster.EmitInRange(
          NetEvents.InventoryGroundDropDespawn,
          { DropID: String(Drop.ID) },
          {
            X: Number.parseFloat(Drop.PositionX),
            Y: Number.parseFloat(Drop.PositionY),
            Z: Number.parseFloat(Drop.PositionZ),
          },
          InventoryNetBroadcastRangeMeters,
          Drop.World,
        );
      }
    } catch (Err: unknown) {
      this.Log.Warn(`SweepEvidenceDrops failed type=${ItemTypeID}`, { Err: String(Err) });
    }
    if (Swept > 0) {
      this.Log.Info(`Evidence sweep removed ${Swept} drop(s)`, { Type: ItemTypeID });
    }
    return Swept;
  }

  // ── Weapon equip / unequip / reload / shot / attach / detach ──────

  /**
   * Equip the weapon in `SlotIndex`. Reads canonical LoadedAmmo +
   * AttachedComponents from the row's metadata, projects them onto the
   * `Roleplay:EquippedWeapon` state bag, and applies the loadout to
   * the ped through the server-side weapon natives.
   */
  async EquipWeapon(Source: number, SlotIndex: number): Promise<InventoryEquipResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    // The row read and the bag write are one atomic window against this
    // inventory. Drop / give / container-store all test IsRowEquipped
    // while holding this same lock, so equipping outside it left a real
    // gap: a concurrent handover could delete the row between the read
    // and the write, and the giver kept a fully functional ped weapon -
    // damaging, consuming no server-side ammo and logging no discharge -
    // while the row itself moved to the recipient.
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const ExistingBag = this.ReadEquippedBag(Source);
      if (ExistingBag !== null) {
        return { Outcome: 'InvalidUse', Detail: 'You are already holding a weapon.' };
      }
      const Items = await this.Repo.LoadItems(Inv.ID);
      const Row = Items.find((R) => R.SlotIndex === SlotIndex);
      if (Row === undefined) return { Outcome: 'NotFound', Detail: 'Slot is empty.' };
      const Type = GetItemType(Row.ItemTypeID);
      if (Type === undefined) return { Outcome: 'UnknownItemType' };
      if (Type.IsWeapon !== true || Type.WeaponHash === undefined) {
        return { Outcome: 'InvalidUse', Detail: 'That item is not a weapon.' };
      }

      const Metadata = ParseMetadata(Row.MetadataJson);
      const LoadedAmmo = ReadLoadedAmmo(Metadata);
      const Components = ReadAttachedComponents(Metadata);
      // A throwable's stack IS its ammunition - the ped arms with the
      // full stack and the discharge path consumes the row per throw.
      const Total =
        Type.IsThrowable === true
          ? (Row.StackQuantity ?? 1)
          : LoadedAmmo.reduce((Acc, Seg) => Acc + Seg.Qty, 0);

      const Bag: EquippedWeaponBag = {
        ItemRowID: String(Row.ID),
        WeaponHash: Type.WeaponHash,
        LoadedAmmoTotal: Total,
        ComponentHashes: Components.map((C) => C.ComponentHash),
        UniqueSerial: Row.UniqueSerial,
      };
      this.WriteEquippedBag(Source, Bag);
      this.ApplyWeaponLoadout(Source, Type.WeaponHash, Total, Bag.ComponentHashes, []);
      return {
        Outcome: 'Ok',
        WeaponHash: Type.WeaponHash,
        LoadedAmmoTotal: Total,
        ComponentHashes: Bag.ComponentHashes,
        ItemRowID: Row.ID,
        UniqueSerial: Row.UniqueSerial,
      };
    } finally {
      Release();
    }
  }

  /**
   * Unequip the currently held weapon. Clears the state bag and
   * removes the weapon from the ped server-side.
   */
  UnequipWeapon(Source: number): Promise<InventoryEquipResult> {
    const Bag = this.ReadEquippedBag(Source);
    if (Bag === null) {
      return Promise.resolve({ Outcome: 'InvalidUse', Detail: 'You have no weapon equipped.' });
    }
    this.WriteEquippedBag(Source, null);
    this.StripWeapon(Source, Bag.WeaponHash);
    return Promise.resolve({ Outcome: 'Ok' });
  }

  /**
   * Synchronous EquippedWeapon clear - decision 21 detach ordering.
   * Nulls the bag and strips every ped weapon server-side, so the
   * teardown is complete before the caller moves routing buckets;
   * nothing depends on the old client receiving anything in order.
   */
  ClearEquippedWeapon(Source: number): void {
    this.WriteEquippedBag(Source, null);
    this.StripAllWeapons(Source);
  }

  /**
   * `/reload` - consume up to `MaxAmmo - LoadedTotal` rounds from
   * compatible ammo rows (largest stack first), append a new FIFO
   * segment, assert the new total on the ped via SetPedAmmo.
   */
  async Reload(Source: number): Promise<InventoryReloadResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Bag = this.ReadEquippedBag(Source);
    if (Bag === null) {
      return { Outcome: 'InvalidUse', Detail: 'No weapon equipped.' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const Items = await this.Repo.LoadItems(Inv.ID);
      const BagRowID = String(Bag.ItemRowID);
      const Weapon = Items.find((R) => String(R.ID) === BagRowID);
      if (Weapon === undefined) {
        this.Log.Info(`Reload: equipped row not in inventory source=${Source}`, {
          BagItemRowID: BagRowID,
          InventoryRowIDs: Items.map((R) => String(R.ID)),
        });
        return { Outcome: 'NotFound', Detail: 'Equipped weapon was lost.' };
      }
      const WeaponType = GetItemType(Weapon.ItemTypeID);
      if (WeaponType === undefined || WeaponType.MaxAmmo === undefined) {
        return { Outcome: 'InvalidUse' };
      }
      const Metadata = ParseMetadata(Weapon.MetadataJson);
      const LoadedAmmo = ReadLoadedAmmo(Metadata);
      const LoadedTotal = LoadedAmmo.reduce((Acc, Seg) => Acc + Seg.Qty, 0);
      const Room = WeaponType.MaxAmmo - LoadedTotal;
      if (Room <= 0) {
        return { Outcome: 'InvalidUse', Detail: 'Magazine is full.' };
      }
      const Compatible = Items.filter((R) => {
        const T = GetItemType(R.ItemTypeID);
        if (T?.IsAmmunition !== true) return false;
        return T.CompatibleWeaponHashes?.includes(Bag.WeaponHash) === true;
      }).sort((A, B) => (B.StackQuantity ?? 0) - (A.StackQuantity ?? 0));
      if (Compatible.length === 0) {
        return { Outcome: 'InvalidUse', Detail: 'No compatible ammo in inventory.' };
      }

      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      let Consumed = 0;
      try {
        for (const AmmoRow of Compatible) {
          if (Consumed >= Room) break;
          const AmmoType = GetItemType(AmmoRow.ItemTypeID);
          if (AmmoType === undefined) continue;
          const Available = AmmoRow.StackQuantity ?? 0;
          if (Available <= 0) continue;
          const Take = Math.min(Available, Room - Consumed);
          const Result = await this.PerformRemove(
            Inv.ID,
            AmmoRow.SlotIndex,
            Take,
            {
              ActorSource: Source,
              ActorCharacterID: PlayerState.CharacterID,
              Action: 'Reload',
              Reason: 'Reload',
              TransactionID,
            },
            T,
          );
          if (Result.Outcome !== 'Ok') break;
          // Append a new segment to LoadedAmmo. Merge with the tail
          // only when both the ammo type AND the custom name match -
          // player-renamed rounds ("9mm R.I.P.") keep their identity
          // through the magazine instead of blending into plain stock.
          const Tail = LoadedAmmo[LoadedAmmo.length - 1];
          if (
            Tail !== undefined &&
            Tail.ItemTypeID === AmmoRow.ItemTypeID &&
            (Tail.CustomName ?? null) === AmmoRow.CustomName
          ) {
            Tail.Qty += Take;
          } else {
            LoadedAmmo.push({
              ItemTypeID: AmmoRow.ItemTypeID,
              Qty: Take,
              ...(AmmoRow.CustomName !== null ? { CustomName: AmmoRow.CustomName } : {}),
            });
          }
          Consumed += Take;
        }
        if (Consumed === 0) {
          await T.rollback();
          return { Outcome: 'InvalidUse', Detail: 'No compatible ammo in inventory.' };
        }
        // Same as the discharge path: the row's metadata was read under
        // this lock a few lines up, so skip the re-SELECT.
        await this.Repo.MergeMetadata(Bag.ItemRowID, { LoadedAmmo }, T, Weapon.MetadataJson);
        await this.MutationLog.Append(
          {
            Action: 'Reload',
            TransactionID,
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            ItemTypeID: WeaponType.ID,
            Quantity: Consumed,
            UniqueSerial: Weapon.UniqueSerial,
            FromInventoryID: Inv.ID,
            FromSlotIndex: Weapon.SlotIndex,
          },
          T,
        );
        await T.commit();
        const NewTotal = LoadedTotal + Consumed;
        Bag.LoadedAmmoTotal = NewTotal;
        this.WriteEquippedBag(Source, Bag);
        this.ApplyLoadedAmmo(Source, Bag.WeaponHash, NewTotal);
        return {
          Outcome: 'Ok',
          WeaponHash: Bag.WeaponHash,
          NewTotal,
          Consumed,
        };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`Reload failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /**
   * Cached CharacterID -> InventoryID resolve for the per-shot hot
   * path. `GetOrCreateForCharacter` costs a SELECT per call and the
   * shot handler runs at up to 25 events/sec/player; the ID itself is
   * immutable so the first resolve is the only one that hits the DB.
   */
  private async ResolveInventoryID(CharacterID: string): Promise<string> {
    const Cached = this.InventoryIDByCharacter.get(CharacterID);
    if (Cached !== undefined) return Cached;
    const Inv = await this.Repo.GetOrCreateForCharacter(CharacterID);
    this.InventoryIDByCharacter.set(CharacterID, Inv.ID);
    return Inv.ID;
  }

  /**
   * Server-authoritative WeaponShot handler. Validates rate-limit,
   * sizes the pop from the gap between the server's loaded total and
   * the client's reported remainder (clamped to the weapon's
   * MaxBurstPerEvent), pops head-first across the FIFO segments,
   * persists, logs.
   */
  async HandleWeaponShot(
    Source: number,
    Payload: NetEventPayloads[typeof NetEvents.InventoryWeaponShot],
  ): Promise<void> {
    // Guarded: one call per discharge, and the `Extra` object literal was
    // being allocated per shot regardless of threshold.
    if (DebugEnabled()) {
      this.Log.Debug(`WeaponShot received source=${Source}`, {
        WeaponHash: Payload.WeaponHash,
        ExpectedRemainingAmmo: Payload.ExpectedRemainingAmmo,
      });
    }
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      this.Log.Info(`WeaponShot rejected: not spawned source=${Source}`);
      return;
    }
    const Bag = this.ReadEquippedBag(Source);
    if (Bag === null) {
      this.Log.Info(`WeaponShot rejected: no equipped bag source=${Source}`);
      return;
    }
    if (Bag.WeaponHash !== Payload.WeaponHash) {
      this.Log.Info(`WeaponShot rejected: hash mismatch source=${Source}`, {
        BagHash: Bag.WeaponHash,
        PayloadHash: Payload.WeaponHash,
      });
      return;
    }

    // Liveness is stamped only after the equipped-bag and hash-match
    // gates: an honest client's claims always clear both, so its poll
    // liveness is unaffected, while dry-fire / garbage claims (no bag,
    // wrong hash) no longer count as proof of life and can no longer
    // mask a ShotsUnreported silent discharge.
    this.StampShotClaim(Source);

    if (!this.CheckShotRateLimit(Source)) {
      this.Log.Info(`WeaponShot rejected: rate limit source=${Source}`);
      this.CountShotRateRejection(Source);
      return;
    }

    const InventoryID = await this.ResolveInventoryID(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const Weapon = await this.Repo.FindItemByID(Bag.ItemRowID);
      if (Weapon === null) {
        this.Log.Info(`WeaponShot rejected: row not found source=${Source} ID=${Bag.ItemRowID}`);
        return;
      }
      // Defence in depth: the resolved row must belong to the shooter's
      // own inventory. The bag is now server-trusted so a cross-character
      // ItemRowID should be impossible, but a row whose InventoryID does
      // not match the shooter is rejected and logged rather than acted on.
      if (Weapon.InventoryID !== InventoryID) {
        this.Log.Warn(`WeaponShot rejected: row inventory mismatch source=${Source}`, {
          ItemRowID: Bag.ItemRowID,
          RowInventoryID: Weapon.InventoryID,
          ShooterInventoryID: InventoryID,
        });
        return;
      }
      const Type = GetItemType(Weapon.ItemTypeID);
      if (Type?.IsWeapon !== true) {
        this.Log.Info(`WeaponShot rejected: not a weapon source=${Source} type=${Weapon.ItemTypeID}`);
        return;
      }
      if (Type.IsThrowable === true) {
        await this.PopThrowableFromStack(
          Source,
          PlayerState.CharacterID,
          InventoryID,
          Bag,
          Weapon,
          Type,
          Payload.ExpectedRemainingAmmo,
        );
        return;
      }
      const Metadata = ParseMetadata(Weapon.MetadataJson);
      const LoadedAmmo = ReadLoadedAmmo(Metadata);
      if (LoadedAmmo.length === 0) {
        this.Log.Info(`WeaponShot rejected: LoadedAmmo empty source=${Source}`);
        // InfiniteAmmo counts here and only here: every earlier reject
        // is structural (not spawned, no bag, hash mismatch, rate
        // limit, missing row, non-weapon) and every later claim is
        // served - possibly clamped - from a non-empty FIFO. This is
        // the one spot where the server knows the gun is dry yet the
        // client still reports rounds leaving the magazine.
        this.CountAmmoUnderflow(Source, Bag.WeaponHash);
        return;
      }
      const MaxBurst = Type.MaxBurstPerEvent ?? 3;
      const Head = LoadedAmmo[0];
      if (Head === undefined) return;
      // Server-authoritative: the client collapses every round it
      // observes leaving the magazine within one poll window into a
      // single WeaponShot event, so the pop is sized from the gap
      // between the server's loaded total and the client's reported
      // remainder. The claim is clamped to the weapon's
      // MaxBurstPerEvent so a fabricated remainder cannot drain whole
      // segments in one event, and floored at one because an accepted
      // event always represents at least one discharge (decision 42).
      const LastKnownTotal = LoadedAmmo.reduce((Acc, Seg) => Acc + Seg.Qty, 0);
      const Claimed = Number.isFinite(Payload.ExpectedRemainingAmmo)
        ? Math.floor(LastKnownTotal - Payload.ExpectedRemainingAmmo)
        : 1;
      const Pop = Math.min(Math.max(Claimed, 1), MaxBurst);
      // Rounds leave head-first across segments so a pop spanning a
      // segment boundary preserves the FIFO load order; the mutation
      // log carries the head segment's ammo type for the whole pop.
      const AmmoTypeID = Head.ItemTypeID;
      let Remaining = Pop;
      while (Remaining > 0 && LoadedAmmo.length > 0) {
        const Segment = LoadedAmmo[0];
        if (Segment === undefined) break;
        const Take = Math.min(Segment.Qty, Remaining);
        Segment.Qty -= Take;
        Remaining -= Take;
        if (Segment.Qty <= 0) LoadedAmmo.shift();
      }
      const Popped = Pop - Remaining;

      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        // `Weapon.MetadataJson` was read at the top of this locked
        // window and nothing has written the row since, so hand it to
        // the merge instead of making it re-SELECT. This is the highest
        // frequency write in the system - one per discharge.
        await this.Repo.MergeMetadata(Bag.ItemRowID, { LoadedAmmo }, T, Weapon.MetadataJson);
        await this.MutationLog.Append(
          {
            Action: 'WeaponShot',
            TransactionID,
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            ItemTypeID: Type.ID,
            Quantity: Popped,
            UniqueSerial: Weapon.UniqueSerial,
            FromInventoryID: InventoryID,
            FromSlotIndex: Weapon.SlotIndex,
            Reason: AmmoTypeID,
          },
          T,
        );
        await T.commit();
        // Best-effort past the commit - see DropToGround: the casing
        // spawn opens its own transaction, and letting it throw into the
        // outer catch would roll back an already-committed one.
        try {
          const NewTotal = LoadedAmmo.reduce((Acc, Seg) => Acc + Seg.Qty, 0);
          Bag.LoadedAmmoTotal = NewTotal;
          this.WriteEquippedBag(Source, Bag);
          // Per-shot accounting lives in the mutation log; console only
          // carries it at debug level.
          if (DebugEnabled()) {
            this.Log.Debug(`WeaponShot accepted source=${Source}`, {
              ItemRowID: Bag.ItemRowID,
              AmmoTypeID,
              Popped,
              NewLoadedTotal: NewTotal,
            });
          }
          await this.SpawnShellCasing(Source, Type.ID, Weapon.UniqueSerial);
        } catch (Err: unknown) {
          this.Log.Error(`WeaponShot post-commit failed source=${Source}`, { Err: String(Err) });
        }
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`HandleWeaponShot failed source=${Source}`, { Err: String(Err) });
      }
    } finally {
      Release();
    }
  }

  /**
   * Throwable discharge: the stack is the magazine. Pops the claimed
   * throws (clamped to MaxBurstPerEvent, default one per event) off the
   * row's StackQuantity, mirrors the new count onto the bag, and
   * unequips + strips once the last one leaves the hand (the engine
   * already removed the ped weapon when its ammo hit zero). Runs inside
   * HandleWeaponShot's inventory lock.
   */
  private async PopThrowableFromStack(
    Source: number,
    CharacterID: string,
    InventoryID: string,
    Bag: EquippedWeaponBag,
    Weapon: InventoryItem,
    Type: ItemTypeDefinition,
    ExpectedRemaining: number,
  ): Promise<void> {
    const Stack = Weapon.StackQuantity ?? 1;
    const Claimed = Number.isFinite(ExpectedRemaining)
      ? Math.floor(Stack - ExpectedRemaining)
      : 1;
    const Pop = Math.min(Math.max(Claimed, 1), Type.MaxBurstPerEvent ?? 1, Stack);
    const T = await this.Database.transaction();
    try {
      const Result = await this.PerformRemove(
        InventoryID,
        Weapon.SlotIndex,
        Pop,
        {
          ActorSource: Source,
          ActorCharacterID: CharacterID,
          Action: 'WeaponShot',
          Reason: Type.ID,
        },
        T,
      );
      if (Result.Outcome !== 'Ok') {
        await T.rollback();
        this.Log.Warn(`Throwable pop remove failed source=${Source}`, {
          Type: Type.ID,
          Outcome: Result.Outcome,
        });
        return;
      }
      await T.commit();
    } catch (Err: unknown) {
      await T.rollback();
      this.Log.Error(`PopThrowableFromStack failed source=${Source}`, { Err: String(Err) });
      return;
    }
    const NewTotal = Stack - Pop;
    if (NewTotal <= 0) {
      this.WriteEquippedBag(Source, null);
      this.StripWeapon(Source, Bag.WeaponHash);
    } else {
      Bag.LoadedAmmoTotal = NewTotal;
      this.WriteEquippedBag(Source, Bag);
    }
    if (DebugEnabled()) {
      this.Log.Debug(`Throwable popped source=${Source}`, { Type: Type.ID, Pop, NewTotal });
    }
  }

  /**
   * Spawn a system-generated evidence drop (shell casing, blood
   * splat) at the Source ped's foot coordinate. Deliberately bypasses
   * the player drop pipeline: evidence is minted by server systems
   * rather than moved out of an inventory, so there is no row to
   * remove and no droppability gate to consult. Returns the created
   * DropID, or null when the type is unknown, the ped coordinate is
   * unreadable, or the insert fails.
   */
  async SpawnEvidenceDrop(
    Source: number,
    ItemTypeID: string,
    MetadataJson: string | null,
  ): Promise<string | null> {
    const Type = GetItemType(ItemTypeID);
    if (Type === undefined) return null;
    const Coord = this.ReadPedCoord(Source);
    if (Coord === null) return null;
    const FootZ = Coord.Z - PedOriginToFeetMeters;
    try {
      const Drop = await this.Ground.Create({
        ItemTypeID,
        StackQuantity: 1,
        WeightGrams: Type.WeightGrams.toFixed(2),
        MetadataJson,
        CustomName: null,
        UniqueSerial: null,
        BoundCharacterID: null,
        DroppedByCharacterID: this.State.Get(Source)?.CharacterID ?? null,
        ContainerInventoryID: null,
        World: Coord.World,
        PositionX: Coord.X.toFixed(3),
        PositionY: Coord.Y.toFixed(3),
        PositionZ: FootZ.toFixed(3),
        DroppedAt: new Date(),
      });
      const Label = this.BuildGroundLabel(Drop, Type);
      this.NetBroadcaster.EmitInRange(
        NetEvents.InventoryGroundDropSpawn,
        {
          DropID: String(Drop.ID),
          X: Coord.X,
          Y: Coord.Y,
          Z: FootZ,
          World: Coord.World,
          Label,
          Model: Type.WorldObjectModel ?? '',
          ...RotationFragment(Type),
        },
        { X: Coord.X, Y: Coord.Y, Z: FootZ },
        InventoryNetBroadcastRangeMeters,
        Coord.World,
      );
      return String(Drop.ID);
    } catch (Err: unknown) {
      this.Log.Warn(`SpawnEvidenceDrop failed source=${Source}`, {
        Type: ItemTypeID,
        Err: String(Err),
      });
      return null;
    }
  }

  /**
   * Drop a single shell casing at the shooter's foot coord. Carries the
   * weapon's UniqueSerial in metadata so forensic pickup + /inspectitem
   * surfaces it (or `N/A` when the weapon's serial was defaced before
   * the shot).
   */
  private async SpawnShellCasing(
    Source: number,
    WeaponTypeID: string,
    WeaponSerial: string | null,
  ): Promise<void> {
    // Casing class is declared per weapon type; weapons that retain
    // their casings (revolvers, break-actions, energy weapons,
    // launchers) carry no ShellCasingTypeID and drop nothing.
    const CasingType = GetItemType(WeaponTypeID)?.ShellCasingTypeID ?? null;
    if (CasingType === null) return;
    await this.SpawnEvidenceDrop(
      Source,
      CasingType,
      JSON.stringify({ WeaponSerial: WeaponSerial ?? 'N/A' }),
    );
  }

  /**
   * Record a discharge that hit a target. Called from the
   * `weaponDamageEvent` hook in InventoryController. Damage is the
   * client-reported override and is 0 when the weapon-meta default
   * applies (the common case). HitComponent is the raw ped component
   * id from the event, null when it carried no usable value.
   */
  async RecordWeaponDischarge(
    ShooterSource: number | null,
    VictimSource: number | null,
    WeaponHash: number,
    Damage: number,
    HitComponent: number | null,
  ): Promise<void> {
    const ShooterState =
      ShooterSource !== null ? this.State.Get(ShooterSource) : null;
    const VictimState =
      VictimSource !== null ? this.State.Get(VictimSource) : null;
    const ShooterCharacterID = ShooterState?.CharacterID ?? null;
    const VictimCharacterID = VictimState?.CharacterID ?? null;

    let HadEquippedBag = false;
    let WeaponSerial = '';
    let WeaponTypeID = '';
    let AmmoTypeID: string | null = null;

    if (ShooterSource !== null) {
      const Bag = this.ReadEquippedBag(ShooterSource);
      // The held gun is only credited for damage its own hash dealt. A
      // vehicle run-over or vehicle-mounted weapon carries an event hash
      // other than the held gun's; crediting it would stamp the wrong
      // serial onto the forensic row and falsely count toward
      // ShotsUnreported. On a mismatch the bag is treated as absent so
      // the no-bag logic below (with its catalog / throwable suppression)
      // takes over instead.
      if (Bag !== null && (WeaponHash >>> 0) === (Bag.WeaponHash >>> 0)) {
        HadEquippedBag = true;
        WeaponSerial = Bag.UniqueSerial ?? '';
        const Weapon = await this.Repo.FindItemByID(Bag.ItemRowID);
        if (Weapon !== null) {
          WeaponTypeID = Weapon.ItemTypeID;
          const Metadata = ParseMetadata(Weapon.MetadataJson);
          const LoadedAmmo = ReadLoadedAmmo(Metadata);
          AmmoTypeID = LoadedAmmo[0]?.ItemTypeID ?? null;
        }
      }
    }
    if (WeaponSerial.length === 0 || WeaponTypeID.length === 0) {
      // No forensic row without a serial - but damage from a catalog
      // firearm with NO equipped bag at all means the server never put
      // that weapon in the shooter's hand. Unarmed, vehicle, and fall
      // damage hashes are outside the catalog and fall through silently;
      // a granted-but-serialless weapon (HadEquippedBag) is not a signal.
      // Throwables are exempt: a player's last grenade nulls the bag at
      // throw time, yet the projectile detonates seconds later with no
      // bag behind it - which would otherwise read as a weapon never
      // granted. Sticky bombs detonate on command (an even longer gap),
      // so a plain exemption is the safe default.
      if (
        ShooterSource !== null &&
        !HadEquippedBag &&
        IsCatalogWeaponHash(WeaponHash >>> 0) &&
        !IsThrowableWeaponHash(WeaponHash >>> 0)
      ) {
        this.Anticheat.ReportWeaponNotGranted(ShooterSource, WeaponHash >>> 0);
      }
      return;
    }

    const ReadVictimCoord = (Source: number | null): { World: number; X: number; Y: number; Z: number } | null => {
      if (Source === null) return null;
      return this.ReadPedCoord(Source);
    };
    const Coord = ReadVictimCoord(VictimSource) ?? ReadVictimCoord(ShooterSource);
    if (Coord === null) return;

    // Success path: the weapon was granted and a forensic row is about
    // to land. A discharge from an ammo-consuming weapon with no live
    // WeaponShot claim behind it means the client's ammo poll went
    // silent while the gun kept firing.
    if (ShooterSource !== null) this.CountSilentDischarge(ShooterSource, WeaponTypeID);

    await this.DischargeLog.Append({
      TransactionID: randomUUID(),
      WeaponSerial,
      WeaponTypeID,
      AmmoTypeID,
      ShooterCharacterID,
      VictimCharacterID,
      Damage,
      HitComponent,
      World: Coord.World,
      PositionX: Coord.X.toFixed(3),
      PositionY: Coord.Y.toFixed(3),
      PositionZ: Coord.Z.toFixed(3),
      OccurredAt: new Date(),
    });
  }

  /**
   * Catalog audit (`/aitem testcatalog`). The server gives the
   * admin's ped every catalog weapon (the same apiset-server give the
   * equip flow uses), then asks the client to sweep the catalog
   * through the engine's own validity natives - IsWeaponValid,
   * HasPedGotWeapon, DoesWeaponTakeWeaponComponent, GetWeaponClipSize,
   * drop-model checks. The engine discards an unrecognised hash
   * without an error, so this round-trip is the only way to prove the
   * data against the running game build. The loadout is stripped when
   * the report lands (or on timeout).
   */
  StartCatalogAudit(
    Source: number,
    OnResult: (Result: CatalogAuditResult) => void,
  ): 'Ok' | 'EquippedWeapon' | 'Busy' | 'NoPed' {
    if (this.PendingCatalogAudits.has(Source)) return 'Busy';
    if (this.ReadEquippedBag(Source) !== null) return 'EquippedWeapon';
    const Ped = GetPlayerPed(String(Source));
    if (Ped === 0) return 'NoPed';
    try {
      for (const Type of Object.values(ItemTypes)) {
        if (Type.IsWeapon !== true || Type.WeaponHash === undefined) continue;
        // One round each so throwables register (a zero-ammo throwable
        // is dropped from the ped's loadout by the engine).
        GiveWeaponToPed(Ped, Type.WeaponHash, 1, false, false);
      }
    } catch (Err: unknown) {
      this.Log.Warn(`StartCatalogAudit give failed source=${Source}`, { Err: String(Err) });
      return 'NoPed';
    }
    const Timeout = setTimeout(() => {
      this.PendingCatalogAudits.delete(Source);
      this.StripCatalogAuditLoadout(Source);
      OnResult({ ...EmptyCatalogAuditResult, TimedOut: true });
    }, CatalogAuditTimeoutMs);
    this.PendingCatalogAudits.set(Source, { OnResult, Timeout });
    emitNet(NetEvents.InventoryCatalogAuditRequest, Source, {});
    this.Log.Info(`Catalog audit started source=${Source}`);
    return 'Ok';
  }

  /**
   * Client half reported back. Only honoured while a pending audit
   * exists for the Source; the payload is hostile and is reduced to
   * known catalog IDs and bounded numbers before anything reads it.
   */
  HandleCatalogAuditReport(Source: number, Payload: unknown): void {
    const Pending = this.PendingCatalogAudits.get(Source);
    if (Pending === undefined) {
      this.Log.Warn(`Unsolicited catalog audit report source=${Source}`);
      return;
    }
    clearTimeout(Pending.Timeout);
    this.PendingCatalogAudits.delete(Source);
    this.StripCatalogAuditLoadout(Source);

    const Raw = (typeof Payload === 'object' && Payload !== null ? Payload : {}) as Record<
      string,
      unknown
    >;
    const Result: CatalogAuditResult = {
      TimedOut: false,
      CheckedWeapons: BoundedCount(Raw.CheckedWeapons),
      CheckedComponents: BoundedCount(Raw.CheckedComponents),
      ResolvedComponentModels: BoundedCount(Raw.ResolvedComponentModels),
      InvalidWeapons: KnownTypeIDList(Raw.InvalidWeapons),
      MissingWeapons: KnownTypeIDList(Raw.MissingWeapons),
      ComponentRejections: KnownTypeIDPairList(Raw.ComponentRejections),
      ClipSizeMismatches: ClipMismatchList(Raw.ClipSizeMismatches),
      InvalidDropModels: KnownTypeIDList(Raw.InvalidDropModels),
    };
    this.Log.Info(`Catalog audit report source=${Source}`, { Result });
    Pending.OnResult(Result);
  }

  /**
   * Clear the weapons the catalog audit handed the admin's ped.
   *
   * Runs on both the success and timeout paths - a client that never
   * reports back must not leave the admin holding the whole catalog.
   */
  private StripCatalogAuditLoadout(Source: number): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped !== 0) RemoveAllPedWeapons(Ped, true);
    } catch (Err: unknown) {
      this.Log.Warn(`StripCatalogAuditLoadout failed source=${Source}`, { Err: String(Err) });
    }
  }

  private readonly PendingCatalogAudits = new Map<
    number,
    { OnResult: (Result: CatalogAuditResult) => void; Timeout: ReturnType<typeof setTimeout> }
  >();

  /** Install `ComponentSlot` into the weapon at `WeaponSlot`. */
  async AttachComponent(
    Source: number,
    ComponentSlot: number,
    WeaponSlot: number,
  ): Promise<InventoryAttachResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const Items = await this.Repo.LoadItems(Inv.ID);
      const Component = Items.find((R) => R.SlotIndex === ComponentSlot);
      const Weapon = Items.find((R) => R.SlotIndex === WeaponSlot);
      if (Component === undefined || Weapon === undefined) return { Outcome: 'NotFound' };
      const CType = GetItemType(Component.ItemTypeID);
      const WType = GetItemType(Weapon.ItemTypeID);
      if (
        CType?.IsWeaponComponent !== true ||
        CType.AttachmentSlot === undefined ||
        CType.ComponentHash === undefined
      ) {
        return { Outcome: 'InvalidUse', Detail: 'Item is not a weapon component.' };
      }
      if (WType?.IsWeapon !== true || WType.WeaponHash === undefined) {
        return { Outcome: 'InvalidUse', Detail: 'Target slot does not hold a weapon.' };
      }
      if (CType.CompatibleWeaponHashes?.includes(WType.WeaponHash) !== true) {
        return { Outcome: 'BlacklistedCategory', Detail: 'Component is not compatible with that weapon.' };
      }

      const Metadata = ParseMetadata(Weapon.MetadataJson);
      const Components = ReadAttachedComponents(Metadata);
      const ExistingIdx = Components.findIndex((C) => C.AttachmentSlot === CType.AttachmentSlot);

      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      let DetachedSlot: number | undefined;
      try {
        // Mutually exclusive slot replacement: detach the prior
        // component back into the holder's inventory first. If the
        // inventory has no room, refuse.
        if (ExistingIdx >= 0) {
          const Existing = Components[ExistingIdx];
          if (Existing === undefined) {
            await T.rollback();
            return { Outcome: 'NotFound' };
          }
          const RestoreType = GetItemType(Existing.ItemTypeID);
          if (RestoreType === undefined) {
            await T.rollback();
            return { Outcome: 'UnknownItemType' };
          }
          const FreeSlot = await this.Repo.NextFreeSlot(Inv.ID, Inv.SlotCapacity, T);
          if (FreeSlot === null) {
            await T.rollback();
            return { Outcome: 'OutOfSlots' };
          }
          DetachedSlot = FreeSlot;
          await this.Repo.CreateItem(
            {
              InventoryID: Inv.ID,
              SlotIndex: FreeSlot,
              ItemTypeID: Existing.ItemTypeID,
              StackQuantity: IsStackable(RestoreType) ? 1 : null,
              WeightGrams: RestoreType.WeightGrams.toFixed(2),
            },
            T,
          );
          Components.splice(ExistingIdx, 1);
        }
        Components.push({
          ItemTypeID: CType.ID,
          ComponentHash: CType.ComponentHash,
          AttachmentSlot: CType.AttachmentSlot,
        });
        await this.PerformRemove(
          Inv.ID,
          ComponentSlot,
          1,
          {
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            Action: 'Attach',
            Reason: `Attach to ${WType.ID}`,
            TransactionID,
          },
          T,
        );
        await this.Repo.MergeMetadata(Weapon.ID, { AttachedComponents: Components }, T);
        await this.MutationLog.Append(
          {
            Action: 'Attach',
            TransactionID,
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            ItemTypeID: CType.ID,
            Quantity: 1,
            UniqueSerial: Weapon.UniqueSerial,
            FromInventoryID: Inv.ID,
            FromSlotIndex: ComponentSlot,
            ToInventoryID: Inv.ID,
            ToSlotIndex: WeaponSlot,
          },
          T,
        );
        await T.commit();
        // Refresh the equipped bag + re-project the loadout onto the
        // ped if this weapon is currently equipped. The pre-mutation
        // hash set diffs out the replaced component server-side.
        const Bag = this.ReadEquippedBag(Source);
        if (Bag !== null && String(Bag.ItemRowID) === String(Weapon.ID)) {
          const PreviousComponentHashes = Bag.ComponentHashes;
          Bag.ComponentHashes = Components.map((C) => C.ComponentHash);
          this.WriteEquippedBag(Source, Bag);
          this.ApplyWeaponLoadout(
            Source,
            WType.WeaponHash,
            Bag.LoadedAmmoTotal,
            Bag.ComponentHashes,
            PreviousComponentHashes,
          );
        }
        return {
          Outcome: 'Ok',
          ...(DetachedSlot !== undefined ? { DetachedSlot } : {}),
        };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`AttachComponent failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  /** Detach a component from a weapon and restore it to the inventory. */
  async DetachComponent(
    Source: number,
    WeaponSlot: number,
    Slot: AttachmentSlot,
  ): Promise<InventoryAttachResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Release = await this.Lock.Acquire(Inv.ID);
    try {
      const Items = await this.Repo.LoadItems(Inv.ID);
      const Weapon = Items.find((R) => R.SlotIndex === WeaponSlot);
      if (Weapon === undefined) return { Outcome: 'NotFound' };
      const WType = GetItemType(Weapon.ItemTypeID);
      if (WType?.IsWeapon !== true || WType.WeaponHash === undefined) {
        return { Outcome: 'InvalidUse', Detail: 'That slot does not hold a weapon.' };
      }
      const Metadata = ParseMetadata(Weapon.MetadataJson);
      const Components = ReadAttachedComponents(Metadata);
      const Idx = Components.findIndex((C) => C.AttachmentSlot === Slot);
      if (Idx < 0) {
        return { Outcome: 'NotFound', Detail: 'No component in that slot.' };
      }
      const Removed = Components[Idx];
      if (Removed === undefined) return { Outcome: 'NotFound' };

      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        const InvRow = await this.Repo.FindByID(Inv.ID);
        if (InvRow === null) {
          await T.rollback();
          return { Outcome: 'NotFound' };
        }
        const FreeSlot = await this.Repo.NextFreeSlot(Inv.ID, InvRow.SlotCapacity, T);
        if (FreeSlot === null) {
          await T.rollback();
          return { Outcome: 'OutOfSlots' };
        }
        const RestoreType = GetItemType(Removed.ItemTypeID);
        if (RestoreType === undefined) {
          await T.rollback();
          return { Outcome: 'UnknownItemType' };
        }
        await this.Repo.CreateItem(
          {
            InventoryID: Inv.ID,
            SlotIndex: FreeSlot,
            ItemTypeID: Removed.ItemTypeID,
            StackQuantity: IsStackable(RestoreType) ? 1 : null,
            WeightGrams: RestoreType.WeightGrams.toFixed(2),
          },
          T,
        );
        Components.splice(Idx, 1);
        await this.Repo.MergeMetadata(Weapon.ID, { AttachedComponents: Components }, T);
        await this.MutationLog.Append(
          {
            Action: 'Detach',
            TransactionID,
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            ItemTypeID: Removed.ItemTypeID,
            Quantity: 1,
            UniqueSerial: Weapon.UniqueSerial,
            FromInventoryID: Inv.ID,
            FromSlotIndex: WeaponSlot,
            ToInventoryID: Inv.ID,
            ToSlotIndex: FreeSlot,
          },
          T,
        );
        await T.commit();
        const Bag = this.ReadEquippedBag(Source);
        if (Bag !== null && String(Bag.ItemRowID) === String(Weapon.ID)) {
          const PreviousComponentHashes = Bag.ComponentHashes;
          Bag.ComponentHashes = Components.map((C) => C.ComponentHash);
          this.WriteEquippedBag(Source, Bag);
          this.ApplyWeaponLoadout(
            Source,
            WType.WeaponHash,
            Bag.LoadedAmmoTotal,
            Bag.ComponentHashes,
            PreviousComponentHashes,
          );
        }
        return { Outcome: 'Ok', DetachedSlot: FreeSlot };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`DetachComponent failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      Release();
    }
  }

  // ── Serial mutations (decision 16) ─────────────────────────────────

  /**
   * Strip a serialised item's number, making it untraceable.
   *
   * Irreversible - there is no re-stamp path - and recorded against the
   * acting account. Refuses (false) on a non-serialised type or one
   * already stripped. Severing the forensic link is the point, so this
   * stays admin-gated with no player-facing equivalent that acts directly.
   */
  async DefaceSerial(InventoryID: string, SlotIndex: number, ActorAccountID: string): Promise<boolean> {
    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const Items = await this.Repo.LoadItems(InventoryID);
      const Row = Items.find((R) => R.SlotIndex === SlotIndex);
      if (Row === undefined) return false;
      const Type = GetItemType(Row.ItemTypeID);
      if (Type?.IsSerialStrippable !== true) return false;
      if (Row.UniqueSerial === null) return false;
      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        await InventoryItem.update(
          { UniqueSerial: null },
          { where: { ID: Row.ID }, transaction: T },
        );
        await this.MutationLog.Append(
          {
            Action: 'Deface',
            TransactionID,
            ActorAccountID,
            ItemTypeID: Row.ItemTypeID,
            UniqueSerial: Row.UniqueSerial,
            FromInventoryID: InventoryID,
            FromSlotIndex: SlotIndex,
            Reason: 'Admin /aitem removeserial',
          },
          T,
        );
        await T.commit();
        return true;
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`DefaceSerial failed inventory=${InventoryID}`, { Err: String(Err) });
        return false;
      }
    } finally {
      Release();
    }
  }

  /**
   * Re-point a holder-bound item at a different character.
   *
   * Refuses (false) unless the type is bound or rebindable. Does NOT
   * verify the target character exists - a typo produces an item bound to
   * a character that never logs in, effectively destroying it. Runs under
   * the inventory lock and writes a Rebind row to the audit trail.
   */
  async RebindHolder(
    InventoryID: string,
    SlotIndex: number,
    NewCharacterID: string,
    ActorAccountID: string,
  ): Promise<boolean> {
    const Release = await this.Lock.Acquire(InventoryID);
    try {
      const Items = await this.Repo.LoadItems(InventoryID);
      const Row = Items.find((R) => R.SlotIndex === SlotIndex);
      if (Row === undefined) return false;
      const Type = GetItemType(Row.ItemTypeID);
      if (Type?.IsHolderBound !== true && Type?.IsHolderRebindable !== true) return false;
      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        await this.Repo.SaveItem(Row.ID, { BoundCharacterID: NewCharacterID }, T);
        await this.MutationLog.Append(
          {
            Action: 'Rebind',
            TransactionID,
            ActorAccountID,
            ItemTypeID: Row.ItemTypeID,
            UniqueSerial: Row.UniqueSerial,
            FromInventoryID: InventoryID,
            FromSlotIndex: SlotIndex,
            Reason: `Rebind to ${NewCharacterID}`,
          },
          T,
        );
        await T.commit();
        return true;
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`RebindHolder failed inventory=${InventoryID}`, { Err: String(Err) });
        return false;
      }
    } finally {
      Release();
    }
  }

  // ── Equipped-bag accessors (used by transfer narrations etc.) ──────

  /**
   * True when the source's equipped-weapon bag points at this specific
   * row. Used by Drop / Transfer / MoveToContainer to refuse acting on
   * the in-hand weapon. State-bag round-trip can flip between string
   * and number so both sides go through String() before compare.
   */
  IsRowEquipped(Source: number, RowID: string | number): boolean {
    const Bag = this.ReadEquippedBag(Source);
    if (Bag === null) return false;
    return String(Bag.ItemRowID) === String(RowID);
  }

  /**
   * Read the authoritative equipped-weapon state for a Source.
   *
   * The trusted read for every weapon decision - discharge attribution,
   * the held-weapon scanner, WeaponNotGranted. See the inline note and
   * the file header: the replicated bag of the same name is a display
   * mirror a modded client can rewrite, and is never consulted here.
   */
  ReadEquippedBag(Source: number): EquippedWeaponBag | null {
    // Trusted read: the server-memory map is the source of truth. The
    // replicated state bag is a client-writable mirror and is never
    // consulted here, so a modded client cannot forge an ItemRowID into
    // any trusted path. The shape guards are retained defensively in
    // case a future writer ever stores a malformed value.
    const Bag = this.EquippedBags.get(Source);
    if (Bag === null || Bag === undefined || typeof Bag !== 'object') return null;
    return Bag;
  }

  /**
   * Set or clear the equipped-weapon state, updating the trusted map
   * first and the replicated display mirror second. Passing null unequips.
   */
  WriteEquippedBag(Source: number, Bag: EquippedWeaponBag | null): void {
    // Memory map is the trusted store; the replicated state bag is a
    // write-only mirror kept in lockstep purely so the Frontend can read
    // it for display / OverMaxClip. Update the trusted store first so a
    // mirror-write failure never leaves the trusted side stale.
    if (Bag === null) {
      this.EquippedBags.delete(Source);
    } else {
      this.EquippedBags.set(Source, Bag);
    }
    try {
      Player(Source).state.set(EquippedWeaponBagKey, Bag, true);
    } catch (Err: unknown) {
      this.Log.Warn(`EquippedWeapon bag write failed source=${Source}`, {
        Err: String(Err),
      });
    }
  }

  // ── Server-side weapon application ──────────────────────────────────
  // Apiset-server natives (see the declares up top). Each helper
  // resolves the ped fresh and swallows native failures with a Warn -
  // the bag/DB state is canonical; a missed engine write self-heals on
  // the next equip cycle.

  /**
   * Project a weapon loadout onto the ped: give, diff components
   * against `PreviousComponentHashes` (a bare re-give does not strip
   * attachments already on the ped), then assert ammo *after* the
   * components because attaching an extended clip can bump the loaded
   * count past the persisted FIFO total, and finally force the weapon
   * into the hands.
   */
  private ApplyWeaponLoadout(
    Source: number,
    WeaponHash: number,
    Ammo: number,
    ComponentHashes: readonly number[],
    PreviousComponentHashes: readonly number[],
  ): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      for (const Stale of PreviousComponentHashes) {
        if (!ComponentHashes.includes(Stale)) {
          RemoveWeaponComponentFromPed(Ped, WeaponHash, Stale);
        }
      }
      GiveWeaponToPed(Ped, WeaponHash, Ammo, false, false);
      for (const Hash of ComponentHashes) {
        GiveWeaponComponentToPed(Ped, WeaponHash, Hash);
      }
      SetPedAmmo(Ped, WeaponHash, Ammo);
      SetCurrentPedWeapon(Ped, WeaponHash, true);
    } catch (Err: unknown) {
      this.Log.Warn(`ApplyWeaponLoadout failed source=${Source} hash=${WeaponHash}`, {
        Err: String(Err),
      });
    }
  }

  /** Remove one weapon from a ped via the engine native. */
  private StripWeapon(Source: number, WeaponHash: number): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      RemoveWeaponFromPed(Ped, WeaponHash);
    } catch (Err: unknown) {
      this.Log.Warn(`StripWeapon failed source=${Source} hash=${WeaponHash}`, {
        Err: String(Err),
      });
    }
  }

  /**
   * Clear a ped's entire loadout. The reconciliation hammer - used when
   * the ped's weapons must be brought back in line with the authoritative
   * inventory state rather than adjusted piecemeal.
   */
  private StripAllWeapons(Source: number): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      RemoveAllPedWeapons(Ped, true);
    } catch (Err: unknown) {
      this.Log.Warn(`StripAllWeapons failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * Push the server's authoritative round count onto the ped's weapon.
   *
   * The server owns ammunition; this is how that decision reaches the
   * engine. Called after equip and reload so the visible magazine matches
   * the inventory rather than whatever the client believed.
   */
  private ApplyLoadedAmmo(Source: number, WeaponHash: number, Ammo: number): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      SetPedAmmo(Ped, WeaponHash, Ammo);
    } catch (Err: unknown) {
      this.Log.Warn(`ApplyLoadedAmmo failed source=${Source} hash=${WeaponHash}`, {
        Err: String(Err),
      });
    }
  }

  // ── Name + description queue (Phase 4 / decision 44) ───────────────

  /**
   * Submit a custom name or description for staff review. Sanitises
   * chat tokens + HTML-style brackets, validates length per kind,
   * enforces per-kind per-character cap.
   */
  async SubmitNameRequest(
    Source: number,
    SlotIndex: number,
    Kind: ItemNameRequestKind,
    RequestedText: string,
  ): Promise<{ Outcome: InventoryOutcome; Detail?: string }> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Items = await this.Repo.LoadItems(Inv.ID);
    const Row = Items.find((R) => R.SlotIndex === SlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound' };
    const Type = GetItemType(Row.ItemTypeID);
    if (Type === undefined) return { Outcome: 'UnknownItemType' };
    if (Kind === 'Name' && Type.AllowsCustomName !== true) {
      return { Outcome: 'InvalidUse', Detail: 'This item type cannot be renamed.' };
    }
    if (Kind === 'Description' && Type.AllowsDescription !== true) {
      return { Outcome: 'InvalidUse', Detail: 'This item type cannot be described.' };
    }
    const Sanitised = SanitiseNameRequest(RequestedText);
    if (Sanitised.length === 0) {
      return { Outcome: 'InvalidUse', Detail: 'Text is empty after sanitisation.' };
    }
    const MinLen = 2;
    const MaxLen = Kind === 'Name' ? 64 : 512;
    if (Sanitised.length < MinLen || Sanitised.length > MaxLen) {
      return {
        Outcome: 'InvalidUse',
        Detail: `${Kind} must be ${MinLen}-${MaxLen} characters.`,
      };
    }
    const Count = await this.NameRequests.CountByCharacterAndKind(PlayerState.CharacterID, Kind);
    if (Count >= 3) {
      return {
        Outcome: 'InvalidUse',
        Detail: `You already have three ${Kind.toLowerCase()} requests pending review.`,
      };
    }
    await this.NameRequests.Upsert(Row.ID, Kind, Sanitised, PlayerState.CharacterID);
    return { Outcome: 'Ok' };
  }

  /**
   * Submit a serial-removal request for staff review. No text input -
   * the moderation queue carries the current serial as audit context.
   * Eligible types: `IsSerialStrippable: true` AND row currently has a
   * non-null `UniqueSerial`. Per-kind cap (3) applies independently.
   */
  async SubmitDefaceRequest(
    Source: number,
    SlotIndex: number,
  ): Promise<{ Outcome: InventoryOutcome; Detail?: string }> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Items = await this.Repo.LoadItems(Inv.ID);
    const Row = Items.find((R) => R.SlotIndex === SlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound' };
    const Type = GetItemType(Row.ItemTypeID);
    if (Type === undefined) return { Outcome: 'UnknownItemType' };
    if (Type.IsSerialStrippable !== true) {
      return { Outcome: 'InvalidUse', Detail: "This item type's serial is not strippable." };
    }
    if (Row.UniqueSerial === null) {
      return { Outcome: 'InvalidUse', Detail: 'This item has no serial to remove.' };
    }
    const Count = await this.NameRequests.CountByCharacterAndKind(PlayerState.CharacterID, 'Deface');
    if (Count >= 3) {
      return {
        Outcome: 'InvalidUse',
        Detail: 'You already have three serial-removal requests pending review.',
      };
    }
    await this.NameRequests.Upsert(Row.ID, 'Deface', Row.UniqueSerial, PlayerState.CharacterID);
    return { Outcome: 'Ok' };
  }

  /** Clear-bypass: null the name / description directly (decision 44). */
  async ClearCustomName(
    Source: number,
    SlotIndex: number,
    Kind: ItemNameRequestKind,
  ): Promise<{ Outcome: InventoryOutcome; Detail?: string }> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Items = await this.Repo.LoadItems(Inv.ID);
    const Row = Items.find((R) => R.SlotIndex === SlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound' };
    if (Kind === 'Name') {
      await this.Repo.SaveItem(Row.ID, { CustomName: null });
    } else {
      await this.Repo.MergeMetadata(Row.ID, { Description: null });
    }
    return { Outcome: 'Ok' };
  }

  /** Size of the naming-moderation queue, for staff notification counts. */
  CountPendingNameRequests(): Promise<number> {
    return this.NameRequests.CountPending();
  }

  /** A page of the naming-moderation queue, backing `/aitem requests`. */
  ListPendingNameRequests(Limit: number, Offset: number): Promise<ItemNameRequest[]> {
    return this.NameRequests.ListPending(Limit, Offset);
  }

  /**
   * Approve a request. For Name, writes to custom_name; for
   * Description, merges into metadata_json.Description.
   */
  async ApproveNameRequest(
    RequestID: string,
    ActorAccountID: string | null = null,
  ): Promise<{ Outcome: InventoryOutcome; Detail?: string }> {
    const Request = await this.NameRequests.FindByID(RequestID);
    if (Request === null) return { Outcome: 'NotFound' };
    const Item = await this.Repo.FindItemByID(Request.InventoryItemID);
    if (Item === null) {
      await this.NameRequests.Delete(RequestID);
      return { Outcome: 'NotFound', Detail: 'Item no longer exists.' };
    }
    if (Request.Kind === 'Name') {
      await this.Repo.SaveItem(Item.ID, { CustomName: Request.RequestedText });
    } else if (Request.Kind === 'Description') {
      await this.Repo.MergeMetadata(Item.ID, { Description: Request.RequestedText });
    } else {
      if (ActorAccountID === null) {
        return { Outcome: 'PermissionDenied', Detail: 'Deface approval requires a staff account.' };
      }
      const Ok = await this.DefaceSerial(Item.InventoryID, Item.SlotIndex, ActorAccountID);
      if (!Ok) {
        return {
          Outcome: 'InvalidUse',
          Detail: 'Deface refused (serial missing or item ineligible).',
        };
      }
    }
    await this.NameRequests.Delete(RequestID);
    return { Outcome: 'Ok' };
  }

  /**
   * Reject a naming request, leaving the item untouched.
   *
   * Takes no reason and records no denial - the row is simply removed, so
   * a denial leaves no trace and the requester is not currently notified.
   * Returns false when the id does not exist.
   */
  async DenyNameRequest(RequestID: string): Promise<boolean> {
    const Request = await this.NameRequests.FindByID(RequestID);
    if (Request === null) return false;
    await this.NameRequests.Delete(RequestID);
    return true;
  }

  /**
   * Per-Source read rate-limit. Mirrors `TryConsumeMutationToken` but
   * for the read-only commands (`/inventory`, `/item nearby`,
   * `/item inspect`, `/item cash`), each of which consumes one token
   * before its first repository read. Capacity 20, refill 10/sec
   * (decision 37).
   */
  TryConsumeReadToken(Source: number): boolean {
    const Now = Date.now();
    const Bucket = this.ReadBuckets.get(Source);
    if (Bucket === undefined) {
      this.ReadBuckets.set(Source, {
        Tokens: InventoryReadRateLimit.Capacity - 1,
        RefilledAt: Now,
      });
      return true;
    }
    const Elapsed = (Now - Bucket.RefilledAt) / 1000;
    const Refill = Elapsed * InventoryReadRateLimit.RefillPerSecond;
    Bucket.Tokens = Math.min(
      InventoryReadRateLimit.Capacity,
      Bucket.Tokens + Refill,
    );
    Bucket.RefilledAt = Now;
    if (Bucket.Tokens < 1) return false;
    Bucket.Tokens -= 1;
    return true;
  }

  // ── Container helpers (Phase 3) ────────────────────────────────────

  /**
   * Resolve a container-inventory back to the item row that owns it
   * plus the inventory the item row lives in. Used by the recursive
   * outer-cap check + container manifest rendering.
   */
  async ResolveContainerParent(
    ContainerInventoryID: string,
  ): Promise<{ Item: InventoryItem; Inventory: Inventory } | null> {
    const Row = await InventoryItem.findOne({
      where: { ContainerInventoryID },
    });
    if (Row === null) return null;
    const Parent = await this.Repo.FindByID(Row.InventoryID);
    if (Parent === null) return null;
    return { Item: Row, Inventory: Parent };
  }

  /**
   * Lazy-create the inner inventory of a container item. Returns the
   * existing inner inventory when one is already attached.
   */
  async OpenContainer(ContainerItem: InventoryItem): Promise<Inventory | null> {
    const Type = GetItemType(ContainerItem.ItemTypeID);
    if (Type?.IsContainer !== true || Type.ContainerSlots === undefined) {
      return null;
    }
    if (ContainerItem.ContainerInventoryID !== null) {
      return await this.Repo.FindByID(ContainerItem.ContainerInventoryID);
    }
    // Create the inner inventory row and stamp the FK on the
    // container item. OwnerType=Container, OwnerID=<container item id>.
    const InnerInv = await Inventory.create({
      OwnerType: 'Container',
      OwnerID: ContainerItem.ID,
      SlotCapacity: Type.ContainerSlots,
      WeightCapacityGrams: (Type.ContainerWeightGrams ?? Type.WeightGrams).toFixed(2),
    });
    await this.Repo.SaveItem(ContainerItem.ID, { ContainerInventoryID: InnerInv.ID });
    return InnerInv;
  }

  /**
   * Move a row from the main inventory into a held container's inner
   * inventory. Lazy-creates the inner inventory if needed.
   */
  async MoveToContainer(
    Source: number,
    FromSlot: number,
    ContainerSlot: number,
    InnerSlot?: number,
  ): Promise<InventoryMoveResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const MainInv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const MainItems = await this.Repo.LoadItems(MainInv.ID);
    const SourceRow = MainItems.find((R) => R.SlotIndex === FromSlot);
    const ContainerRow = MainItems.find((R) => R.SlotIndex === ContainerSlot);
    if (SourceRow === undefined) return { Outcome: 'NotFound', Detail: 'From slot empty.' };
    if (ContainerRow === undefined) return { Outcome: 'NotFound', Detail: 'Container slot empty.' };
    const ContainerType = GetItemType(ContainerRow.ItemTypeID);
    if (ContainerType?.IsContainer !== true) {
      return { Outcome: 'InvalidUse', Detail: 'Target slot is not a container.' };
    }
    const SourceType = GetItemType(SourceRow.ItemTypeID);
    if (SourceType === undefined) return { Outcome: 'UnknownItemType' };
    if (SourceType.IsContainer === true) {
      return { Outcome: 'ContainerNestingForbidden' };
    }
    if (this.IsRowEquipped(Source, SourceRow.ID)) {
      return { Outcome: 'InvalidUse', Detail: 'Unequip the weapon before storing it.' };
    }
    const Inner = await this.OpenContainer(ContainerRow);
    if (Inner === null) return { Outcome: 'NotFound' };

    // Locks: source main + inner container.
    const Locks = await this.AcquireOrderedLocks(MainInv.ID, Inner.ID);
    try {
      const Quantity = SourceRow.StackQuantity ?? 1;
      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        const Metadata =
          SourceRow.MetadataJson !== null
            ? (JSON.parse(SourceRow.MetadataJson) as Record<string, unknown>)
            : undefined;
        const AddOptions: AddItemOptions = {
          ActorSource: Source,
          ActorCharacterID: PlayerState.CharacterID,
          Reason: 'MoveToContainer',
          Action: 'Move',
          ExternalTransaction: T,
          TransactionID,
          AllOrNothing: true,
        };
        if (SourceRow.CustomName !== null) AddOptions.CustomName = SourceRow.CustomName;
        if (Metadata !== undefined) AddOptions.Metadata = Metadata;
        if (SourceRow.BoundCharacterID !== null) AddOptions.BoundCharacterID = SourceRow.BoundCharacterID;

        const Removed = await this.PerformRemove(
          MainInv.ID,
          FromSlot,
          Quantity,
          {
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            Action: 'Move',
            Reason: 'MoveToContainer',
            TransactionID,
          },
          T,
        );
        if (Removed.Outcome !== 'Ok') {
          await T.rollback();
          return { Outcome: Removed.Outcome };
        }
        const Added = await this.PerformAdd(Inner.ID, SourceType, Quantity, AddOptions, T);
        if (Added.Outcome !== 'Ok') {
          await T.rollback();
          return {
            Outcome: Added.Outcome,
            ...(Added.Detail !== undefined ? { Detail: Added.Detail } : {}),
          };
        }
        // Null carries across as null - see the TransferItem note: a
        // defaced weapon must not pick a new serial up on its way into
        // a backpack.
        if (!IsStackable(SourceType) && SourceType.SerialDomain !== undefined) {
          const TouchedSlot = (Added.TouchedSlots ?? [])[0];
          if (TouchedSlot !== undefined) {
            const InnerItems = await this.Repo.LoadItems(Inner.ID);
            const NewRow = InnerItems.find((R) => R.SlotIndex === TouchedSlot);
            if (NewRow !== undefined) {
              await InventoryItem.update(
                { UniqueSerial: SourceRow.UniqueSerial },
                { where: { ID: NewRow.ID }, transaction: T },
              );
            }
          }
        }
        await T.commit();
        void InnerSlot;
        return {
          Outcome: 'Ok',
          FromSlot,
          ...((Added.TouchedSlots ?? [])[0] !== undefined
            ? { ToSlot: (Added.TouchedSlots ?? [])[0] }
            : {}),
        };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`MoveToContainer failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      for (const Release of Locks) Release();
    }
  }

  /**
   * Move a row out of a held container back to the main inventory.
   */
  async MoveFromContainer(
    Source: number,
    ContainerSlot: number,
    InnerSlot: number,
    ToSlot?: number,
  ): Promise<InventoryMoveResult> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned' || PlayerState.CharacterID === null) {
      return { Outcome: 'PermissionDenied' };
    }
    const MainInv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const MainItems = await this.Repo.LoadItems(MainInv.ID);
    const ContainerRow = MainItems.find((R) => R.SlotIndex === ContainerSlot);
    if (ContainerRow === undefined) {
      return { Outcome: 'NotFound', Detail: 'Container slot empty.' };
    }
    if (ContainerRow.ContainerInventoryID === null) {
      return { Outcome: 'NotFound', Detail: 'Container is empty.' };
    }
    const Inner = await this.Repo.FindByID(ContainerRow.ContainerInventoryID);
    if (Inner === null) return { Outcome: 'NotFound' };
    const InnerItems = await this.Repo.LoadItems(Inner.ID);
    const SourceRow = InnerItems.find((R) => R.SlotIndex === InnerSlot);
    if (SourceRow === undefined) {
      return { Outcome: 'NotFound', Detail: 'Inner slot empty.' };
    }
    const SourceType = GetItemType(SourceRow.ItemTypeID);
    if (SourceType === undefined) return { Outcome: 'UnknownItemType' };

    const Locks = await this.AcquireOrderedLocks(MainInv.ID, Inner.ID);
    try {
      const Quantity = SourceRow.StackQuantity ?? 1;
      const T = await this.Database.transaction();
      const TransactionID = randomUUID();
      try {
        const Metadata =
          SourceRow.MetadataJson !== null
            ? (JSON.parse(SourceRow.MetadataJson) as Record<string, unknown>)
            : undefined;
        const AddOptions: AddItemOptions = {
          ActorSource: Source,
          ActorCharacterID: PlayerState.CharacterID,
          Reason: 'MoveFromContainer',
          Action: 'Move',
          ExternalTransaction: T,
          TransactionID,
          AllOrNothing: true,
        };
        if (SourceRow.CustomName !== null) AddOptions.CustomName = SourceRow.CustomName;
        if (Metadata !== undefined) AddOptions.Metadata = Metadata;
        if (SourceRow.BoundCharacterID !== null) AddOptions.BoundCharacterID = SourceRow.BoundCharacterID;

        const Removed = await this.PerformRemove(
          Inner.ID,
          InnerSlot,
          Quantity,
          {
            ActorSource: Source,
            ActorCharacterID: PlayerState.CharacterID,
            Action: 'Move',
            Reason: 'MoveFromContainer',
            TransactionID,
          },
          T,
        );
        if (Removed.Outcome !== 'Ok') {
          await T.rollback();
          return { Outcome: Removed.Outcome };
        }
        const Added = await this.PerformAdd(MainInv.ID, SourceType, Quantity, AddOptions, T);
        if (Added.Outcome !== 'Ok') {
          await T.rollback();
          return {
            Outcome: Added.Outcome,
            ...(Added.Detail !== undefined ? { Detail: Added.Detail } : {}),
          };
        }
        // Null carries across as null - see the TransferItem note.
        if (!IsStackable(SourceType) && SourceType.SerialDomain !== undefined) {
          const TouchedSlot = (Added.TouchedSlots ?? [])[0];
          if (TouchedSlot !== undefined) {
            const NewItems = await this.Repo.LoadItems(MainInv.ID);
            const NewRow = NewItems.find((R) => R.SlotIndex === TouchedSlot);
            if (NewRow !== undefined) {
              await InventoryItem.update(
                { UniqueSerial: SourceRow.UniqueSerial },
                { where: { ID: NewRow.ID }, transaction: T },
              );
            }
          }
        }
        await T.commit();
        void ToSlot;
        return {
          Outcome: 'Ok',
          FromSlot: InnerSlot,
          ...((Added.TouchedSlots ?? [])[0] !== undefined
            ? { ToSlot: (Added.TouchedSlots ?? [])[0] }
            : {}),
        };
      } catch (Err: unknown) {
        await T.rollback();
        this.Log.Error(`MoveFromContainer failed source=${Source}`, { Err: String(Err) });
        return { Outcome: 'NotFound', Detail: 'Database error.' };
      }
    } finally {
      for (const Release of Locks) Release();
    }
  }

  /** Get the inner inventory of a container slot in the player's main inventory. */
  async GetContainerInventory(
    Source: number,
    ContainerSlot: number,
  ): Promise<Inventory | null> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.CharacterID === null) return null;
    const MainInv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const MainItems = await this.Repo.LoadItems(MainInv.ID);
    const Row = MainItems.find((R) => R.SlotIndex === ContainerSlot);
    if (Row === undefined) return null;
    return await this.OpenContainer(Row);
  }

  // ── Internals shared by Phase 2+ methods ───────────────────────────

  /**
   * Acquire both inventory locks in ascending ID order to prevent
   * deadlock. Returns the release functions in the same order; callers
   * release in any order at end-of-window.
   */
  private async AcquireOrderedLocks(
    AID: string,
    BID: string,
  ): Promise<(() => void)[]> {
    const [First, Second] = String(AID).localeCompare(String(BID)) <= 0 ? [AID, BID] : [BID, AID];
    const FirstRelease = await this.Lock.Acquire(First);
    try {
      const SecondRelease = await this.Lock.Acquire(Second);
      return [FirstRelease, SecondRelease];
    } catch (Err: unknown) {
      // The second acquire timed out. Throwing here would strand the
      // FIRST lock forever: the caller never receives its release
      // function, so its `finally` has nothing to release, and
      // AsyncLock never reclaims a held key. That leak is permanent
      // and self-spreading - every later cross-inventory op touching
      // the stranded key times out on ITS second acquire and strands
      // another one. Release before rethrowing.
      FirstRelease();
      throw Err;
    }
  }

  /**
   * Read ped world coord + routing bucket. Server-side reads work for
   * GetEntityCoords / GetPlayerRoutingBucket / GetEntityHeading even
   * when the write counterparts are client-only.
   */
  ReadPedCoord(Source: number): { X: number; Y: number; Z: number; Heading: number; World: number } | null {
    try {
      const SrcStr = String(Source);
      const Ped = GetPlayerPed(SrcStr);
      if (Ped === 0) return null;
      const Coords = GetEntityCoords(Ped);
      const X = Number(Coords[0]);
      const Y = Number(Coords[1]);
      const Z = Number(Coords[2]);
      if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return null;
      const Heading = Number(GetEntityHeading(Ped));
      const World = Number(GetPlayerRoutingBucket(SrcStr));
      return {
        X,
        Y,
        Z,
        Heading: Number.isFinite(Heading) ? Heading : 0,
        World: Number.isFinite(World) ? World : 0,
      };
    } catch (Err: unknown) {
      this.Log.Warn(`ReadPedCoord failed source=${Source}`, { Err: String(Err) });
      return null;
    }
  }

  /**
   * Inter-shot rate limit + rolling window cap (decision 42). Returns
   * true when the shot is admissible; false when it should be dropped.
   */
  private CheckShotRateLimit(Source: number): boolean {
    const Now = Date.now();
    const State = this.WeaponShotStates.get(Source);
    if (State === undefined) {
      this.WeaponShotStates.set(Source, {
        LastShotAt: Now,
        WindowStartedAt: Now,
        WindowCount: 1,
      });
      return true;
    }
    if (Now - State.LastShotAt < WeaponShotMinIntervalMs) return false;
    if (Now - State.WindowStartedAt > WeaponShotWindowMs) {
      State.WindowStartedAt = Now;
      State.WindowCount = 0;
    }
    if (State.WindowCount >= WeaponShotWindowMax) return false;
    State.LastShotAt = Now;
    State.WindowCount += 1;
    return true;
  }

  // ── Weapon-accounting detections (Phase 1 anti-cheat) ───────────────
  // All four helpers are fire-and-forget bookkeeping on hot paths;
  // each swallows its own failures so a detection bug can never break
  // shot handling or discharge logging.

  /** Get-or-create the per-Source detection state. */
  private ResolveShotAccounting(Source: number): ShotAccountingState {
    let State = this.ShotAccounting.get(Source);
    if (State === undefined) {
      State = {
        UnderflowWindowStartedAt: 0,
        UnderflowCount: 0,
        RejectionWindowStartedAt: 0,
        RejectionCount: 0,
        RapidFireSuppressedUntil: 0,
        LastShotClaimMs: null,
        SilentDischargeWindowStartedAt: 0,
        SilentDischargeCount: 0,
      };
      this.ShotAccounting.set(Source, State);
    }
    return State;
  }

  /** Refresh the claim-liveness stamp. Called for every arriving WeaponShot claim. */
  private StampShotClaim(Source: number): void {
    try {
      this.ResolveShotAccounting(Source).LastShotClaimMs = Date.now();
    } catch (Err: unknown) {
      this.Log.Warn(`StampShotClaim failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * InfiniteAmmo detection. A claim that reached the dry-FIFO reject
   * means the server knows the magazine is empty while the client
   * still reports fire. One-off underflows happen legitimately when
   * the final WeaponShot event races the reload/unequip flows, so the
   * Report only fires after the threshold accumulates inside one
   * rolling window; the window then resets.
   */
  private CountAmmoUnderflow(Source: number, WeaponHash: number): void {
    try {
      const Now = Date.now();
      const State = this.ResolveShotAccounting(Source);
      if (Now - State.UnderflowWindowStartedAt > InfiniteAmmoWindowMs) {
        State.UnderflowWindowStartedAt = Now;
        State.UnderflowCount = 0;
      }
      State.UnderflowCount += 1;
      if (State.UnderflowCount < InfiniteAmmoUnderflowThreshold) return;
      this.Anticheat.Report(Source, 'InfiniteAmmo', {
        UnderflowsInWindow: State.UnderflowCount,
        WeaponHash,
      });
      State.UnderflowWindowStartedAt = Now;
      State.UnderflowCount = 0;
    } catch (Err: unknown) {
      this.Log.Warn(`CountAmmoUnderflow failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * RapidBulletFire detection. Network jitter batches legitimate
   * client emits, so a single CheckShotRateLimit rejection is noise;
   * sustained rejections inside one rolling window are the signal.
   * After a Report, further Reports are suppressed for
   * `RapidFireReportSuppressMs` so one macro burst cannot stack score.
   */
  private CountShotRateRejection(Source: number): void {
    try {
      const Now = Date.now();
      const State = this.ResolveShotAccounting(Source);
      if (Now - State.RejectionWindowStartedAt > RapidFireWindowMs) {
        State.RejectionWindowStartedAt = Now;
        State.RejectionCount = 0;
      }
      State.RejectionCount += 1;
      if (State.RejectionCount < RapidFireRejectionThreshold) return;
      if (Now < State.RapidFireSuppressedUntil) return;
      this.Anticheat.Report(Source, 'RapidBulletFire', {
        RejectionsInWindow: State.RejectionCount,
      });
      State.RapidFireSuppressedUntil = Now + RapidFireReportSuppressMs;
      State.RejectionWindowStartedAt = Now;
      State.RejectionCount = 0;
    } catch (Err: unknown) {
      this.Log.Warn(`CountShotRateRejection failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * ShotsUnreported detection. Called from RecordWeaponDischarge's
   * success path. Only ammo-consuming types participate: melee and
   * throwables produce weaponDamageEvents with no WeaponShot claim by
   * design and must never count. A discharge with no claim stamp - or
   * a stale one - means the client suppressed its shot poll while
   * still dealing weapon damage.
   */
  private CountSilentDischarge(ShooterSource: number, WeaponTypeID: string): void {
    try {
      const Type = GetItemType(WeaponTypeID);
      if (Type === undefined) return;
      if (Type.MaxAmmo === undefined || Type.MaxAmmo <= 0 || Type.IsThrowable === true) return;
      // Capture the discharge instant now, but judge liveness later. The
      // client's claim rides a 25 ms poll and arrives a few ms AFTER this
      // damage event, so a synchronous stale-claim test would flag the
      // first honest hit after every lull. After the grace, an honest
      // claim will have landed and refreshed LastShotClaimMs; only a
      // genuinely silent poll still reads stale relative to discharge.
      const DischargeAt = Date.now();
      setTimeout(() => {
        try {
          // The Source may have disconnected / switched characters
          // inside the grace window; its accounting entry is then gone
          // and there is nothing to judge.
          const State = this.ShotAccounting.get(ShooterSource);
          if (State === undefined) return;
          if (
            State.LastShotClaimMs !== null &&
            State.LastShotClaimMs >= DischargeAt - SilentDischargeMaxClaimAgeMs
          ) {
            return;
          }
          if (DischargeAt - State.SilentDischargeWindowStartedAt > SilentDischargeWindowMs) {
            State.SilentDischargeWindowStartedAt = DischargeAt;
            State.SilentDischargeCount = 0;
          }
          State.SilentDischargeCount += 1;
          if (State.SilentDischargeCount < SilentDischargeThreshold) return;
          this.Anticheat.Report(ShooterSource, 'ShotsUnreported', {
            SilentDischargesInWindow: State.SilentDischargeCount,
            WeaponTypeID,
          });
          State.SilentDischargeWindowStartedAt = DischargeAt;
          State.SilentDischargeCount = 0;
        } catch (Err: unknown) {
          this.Log.Warn(`CountSilentDischarge deferred failed source=${ShooterSource}`, {
            Err: String(Err),
          });
        }
      }, SilentDischargeGraceMs);
    } catch (Err: unknown) {
      this.Log.Warn(`CountSilentDischarge failed source=${ShooterSource}`, { Err: String(Err) });
    }
  }

  /** Build the proximity-broadcast label for a ground drop (no serial / no hidden metadata). */
  private BuildGroundLabel(Drop: GroundDrop, Type: ItemTypeDefinition | undefined): string {
    const Display = Type?.DisplayName ?? Drop.ItemTypeID;
    // Currency hides its quantity - the label must not price a pile
    // of money from across the street.
    if (Type?.IsCurrency === true) return `${Display} [ID: ${Drop.ID}]`;
    const Quantity =
      Drop.StackQuantity !== null && Drop.StackQuantity > 1 ? ` x${Drop.StackQuantity}` : '';
    return `${Display}${Quantity} [ID: ${Drop.ID}]`;
  }

  /** Mutation rate-limit check. 10 tokens per second per Source. Returns
   * true when the caller may proceed; false when the bucket is empty.
   * Used upstream of `AddItem` / `RemoveItem` / `MoveItem` / `SplitStack`
   * by the command surface; the service itself does not enforce it
   * (system / admin paths bypass).
   */
  TryConsumeMutationToken(Source: number): boolean {
    const Now = Date.now();
    const Bucket = this.MutationBuckets.get(Source);
    if (Bucket === undefined) {
      this.MutationBuckets.set(Source, {
        Tokens: InventoryMutationRateLimit.Capacity - 1,
        RefilledAt: Now,
      });
      return true;
    }
    const Elapsed = (Now - Bucket.RefilledAt) / 1000;
    const Refill = Elapsed * InventoryMutationRateLimit.RefillPerSecond;
    Bucket.Tokens = Math.min(
      InventoryMutationRateLimit.Capacity,
      Bucket.Tokens + Refill,
    );
    Bucket.RefilledAt = Now;
    if (Bucket.Tokens < 1) return false;
    Bucket.Tokens -= 1;
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * The single implementation behind every add - merging into existing
   * stacks first, then filling free slots.
   *
   * Assumes the caller already holds the inventory lock and, for
   * composites, supplies the transaction; it takes neither itself.
   *
   * The partial-fill contract lives here and is the most dangerous thing
   * in the file. Weight or slot limits can stop part of a quantity
   * landing. By default that is reported as `Ok` with a non-zero
   * `OverflowCount`, which is correct only when the caller has somewhere
   * to put the remainder - `/aitem give` mints from nothing, so an
   * unplaceable surplus simply is not created. Composite callers have
   * ALREADY removed the full quantity from a source, so for them a
   * partial add would commit the shortfall out of existence; they pass
   * `AllOrNothing` and get a refusal with nothing written, letting their
   * rollback restore the source side.
   */
  private async PerformAdd(
    InventoryID: string,
    Type: ItemTypeDefinition,
    Quantity: number,
    Options: AddItemOptions,
    T: Transaction,
  ): Promise<InventoryAddResult> {
    const Inv = await this.Repo.FindByID(InventoryID);
    if (Inv === null) return { Outcome: 'NotFound' };

    // Decision 17: containers cannot live inside other containers. The
    // outer item-row identity is lost across a ground-drop round-trip
    // for nested chains, so the service refuses the move outright.
    if (Inv.OwnerType === 'Container' && Type.IsContainer === true) {
      return { Outcome: 'ContainerNestingForbidden' };
    }

    // Category blacklist: a container type may refuse whole categories
    // (a pistol does not fit in an envelope). PerformAdd is the single
    // choke point for everything entering a container inventory.
    if (Inv.OwnerType === 'Container') {
      const Parent = await this.ResolveContainerParent(Inv.ID);
      const HolderType = Parent !== null ? GetItemType(Parent.Item.ItemTypeID) : undefined;
      if (HolderType?.ContainerBlacklistedCategories?.includes(Type.Category) === true) {
        return {
          Outcome: 'InvalidUse',
          Detail: `A ${Type.DisplayName.toLowerCase()} does not fit in a ${HolderType.DisplayName.toLowerCase()}.`,
        };
      }
    }

    const CapacityCap = Number.parseFloat(Inv.WeightCapacityGrams);
    const CurrentCarry = await this.Repo.CarryWeightGrams(InventoryID, T);
    const PerUnit = Type.WeightGrams;
    const RoomGrams = CapacityCap - CurrentCarry;
    let MaxByWeight =
      PerUnit > 0 ? Math.max(0, Math.floor((RoomGrams + 0.001) / PerUnit)) : Quantity;

    // Recursive outer cap (decision 38). When this inventory is a
    // container, every gram added consumes against the holder's outer
    // WeightCapacityGrams too. Walk up one parent (decision 17 forbids
    // deeper nesting) and clamp MaxByWeight by whichever cap is
    // tighter.
    if (Inv.OwnerType === 'Container' && PerUnit > 0) {
      const Outer = await this.ResolveContainerParent(Inv.ID);
      if (Outer !== null) {
        const OuterCap = Number.parseFloat(Outer.Inventory.WeightCapacityGrams);
        // Outer carry already includes the container's own weight; we
        // also need the existing inner contents counted toward the
        // outer cap (they are carried by the holder).
        const OuterCarry =
          (await this.Repo.CarryWeightGrams(Outer.Inventory.ID, T)) + CurrentCarry;
        const OuterRoom = OuterCap - OuterCarry;
        const OuterMax = Math.max(0, Math.floor((OuterRoom + 0.001) / PerUnit));
        if (OuterMax < MaxByWeight) MaxByWeight = OuterMax;
      }
    }
    const Stackable = IsStackable(Type);
    const TransactionID = Options.TransactionID ?? randomUUID();
    const Action = Options.Action ?? 'Add';

    let Remaining = Math.min(Quantity, MaxByWeight);
    let WeightDeniedExtras = Math.max(0, Quantity - MaxByWeight);
    let Added = 0;
    const TouchedSlots: number[] = [];

    // Type-level default metadata (drug Quality / Purity / strain
    // profile) seeds under whatever the caller supplied - explicit
    // values win. Without this an /aitem give'd drug carries no
    // Purity and a later stack merge dilutes a real batch toward zero.
    const EffectiveMetadata =
      Type.DefaultMetadata !== undefined || Options.Metadata !== undefined
        ? { ...(Type.DefaultMetadata ?? {}), ...(Options.Metadata ?? {}) }
        : undefined;
    const MetadataString = SerialiseMetadata(EffectiveMetadata);
    const CustomName = Options.CustomName ?? null;

    // Stage 1 - merge into existing stacks. Non-blendable keys must
    // match byte-for-byte; blendable keys (decision 27) weighted-
    // average on merge. Loaded metadata for the incoming row is
    // canonicalised first so the per-row compare is stable.
    if (Stackable && Remaining > 0) {
      const Matches = await this.Repo.FindStackableMatches(
        InventoryID,
        Type.ID,
        CustomName,
        T,
      );
      const IncomingMetadata = EffectiveMetadata ?? {};
      const BlendableKeys = new Set(Type.BlendableMetadataKeys ?? []);
      for (const Row of Matches) {
        if (Remaining <= 0) break;
        if (!CanStackMerge(Row.MetadataJson, IncomingMetadata, BlendableKeys)) continue;
        const Current = Row.StackQuantity ?? 0;
        const Room = Type.MaxStack - Current;
        if (Room <= 0) continue;
        const Take = Math.min(Room, Remaining);
        const NewQty = Current + Take;
        const NewWeight = (Type.WeightGrams * NewQty).toFixed(2);
        await this.Repo.SaveItem(
          Row.ID,
          { StackQuantity: NewQty, WeightGrams: NewWeight },
          T,
        );
        // Weighted-average the blendable keys when present on either
        // side. Persist via SetMetadata so the canonical blob reflects
        // the post-merge state.
        if (BlendableKeys.size > 0) {
          const Blended = BlendMetadata(
            ParseMetadata(Row.MetadataJson),
            IncomingMetadata,
            BlendableKeys,
            Current,
            Take,
          );
          await this.Repo.SetMetadata(Row.ID, Blended, T);
        }
        Remaining -= Take;
        Added += Take;
        TouchedSlots.push(Row.SlotIndex);
      }
    }

    // Stage 2 - spill remainder into new slots.
    //
    // The occupied-slot set is read ONCE and then advanced in memory as
    // this loop claims slots. Re-querying per slot re-scanned the whole
    // inventory for every unit of spill, so a large grant (500 rounds at
    // MaxStack 50 = 10 slots) cost ten sequential full scans of the same
    // table inside one transaction. Rows created below are the only
    // writer inside this lock window, so the in-memory set stays exact.
    const TakenSlotSet =
      Remaining > 0 ? await this.Repo.TakenSlots(InventoryID, T) : new Set<number>();
    while (Remaining > 0) {
      const FreeSlot = FirstFreeSlot(TakenSlotSet, Inv.SlotCapacity);
      if (FreeSlot === null) {
        WeightDeniedExtras += Remaining;
        Remaining = 0;
        break;
      }
      TakenSlotSet.add(FreeSlot);
      const Take = Stackable ? Math.min(Type.MaxStack, Remaining) : 1;
      const StackQuantity = Stackable ? Take : null;
      const RowWeight = Stackable
        ? (Type.WeightGrams * Take).toFixed(2)
        : Type.WeightGrams.toFixed(2);
      const UniqueSerial =
        Type.SerialDomain !== undefined ? await this.MintSerial(Type.SerialDomain) : null;
      // Rebindable types (phones, radio) persist their holder too -
      // the give-path rebind and the pickup pass-through both arrive
      // through Options.BoundCharacterID, and gating on IsHolderBound
      // alone silently discarded them, leaving OwnerOnly serials
      // unreadable even by their rightful holder.
      const BoundCharacterID =
        Type.IsHolderBound === true || Type.IsHolderRebindable === true
          ? (Options.BoundCharacterID ?? null)
          : null;
      // Charge-carrying weapons (jerry cans, extinguisher) spawn full:
      // DefaultAmmo > 0 seeds a self-typed LoadedAmmo segment on fresh
      // rows only. Metadata arriving from a transfer or pickup already
      // carries its (possibly drained) charge and is left untouched.
      const RowMetadata =
        Type.IsWeapon === true &&
        (Type.DefaultAmmo ?? 0) > 0 &&
        EffectiveMetadata?.LoadedAmmo === undefined
          ? SerialiseMetadata({
              ...(EffectiveMetadata ?? {}),
              LoadedAmmo: [{ ItemTypeID: Type.ID, Qty: Type.DefaultAmmo }],
            })
          : MetadataString;
      await this.Repo.CreateItem(
        {
          InventoryID,
          SlotIndex: FreeSlot,
          ItemTypeID: Type.ID,
          StackQuantity,
          WeightGrams: RowWeight,
          MetadataJson: RowMetadata,
          CustomName,
          UniqueSerial,
          BoundCharacterID,
        },
        T,
      );
      Remaining -= Take;
      Added += Take;
      TouchedSlots.push(FreeSlot);
    }

    if (Added > 0) {
      await this.MutationLog.Append(
        {
          Action,
          TransactionID,
          ActorSource: Options.ActorSource ?? null,
          ActorCharacterID: Options.ActorCharacterID ?? null,
          ActorAccountID: Options.ActorAccountID ?? null,
          ItemTypeID: Type.ID,
          Quantity: Added,
          ToInventoryID: InventoryID,
          ToSlotIndex: TouchedSlots[0] ?? null,
          Reason: Options.Reason ?? null,
        },
        T,
      );
    }

    // Any shortfall is fatal to an all-or-nothing caller, and a total
    // shortfall is fatal to everyone. Both report which limit bit -
    // a free slot still existing means weight was the binding
    // constraint. The caller rolls the transaction back, so the rows
    // written above (and, for a composite, the source-side removal)
    // never reach the database.
    if (WeightDeniedExtras > 0 && (Added === 0 || Options.AllOrNothing === true)) {
      const Empty = await this.Repo.NextFreeSlot(InventoryID, Inv.SlotCapacity, T);
      const Detail = Empty === null ? 'Inventory is full.' : 'Item is too heavy to carry.';
      return {
        Outcome: Empty === null ? 'OutOfSlots' : 'OverWeight',
        AddedCount: 0,
        OverflowCount: Added + WeightDeniedExtras,
        Detail,
      };
    }

    return {
      Outcome: 'Ok',
      AddedCount: Added,
      OverflowCount: WeightDeniedExtras,
      TouchedSlots,
    };
  }

  /**
   * The single implementation behind every remove: decrement a stack, or
   * delete the row when the whole quantity goes.
   *
   * Like PerformAdd, assumes the caller holds the lock and supplies any
   * transaction. Removing more than the stack holds is refused rather
   * than clamped, so a composite cannot quietly move fewer items than it
   * believes it did.
   */
  private async PerformRemove(
    InventoryID: string,
    SlotIndex: number,
    Quantity: number,
    Options: RemoveItemOptions,
    T: Transaction,
  ): Promise<InventoryRemoveResult> {
    const Items = await this.Repo.LoadItems(InventoryID);
    const Row = Items.find((R) => R.SlotIndex === SlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound' };
    const Type = GetItemType(Row.ItemTypeID);
    if (Type === undefined) return { Outcome: 'UnknownItemType' };

    if (!IsStackable(Type)) {
      if (Quantity !== 1) return { Outcome: 'InvalidQuantity' };
      await this.Repo.DeleteItem(Row.ID, T);
      await this.MutationLog.Append(
        {
          Action: Options.Action ?? 'Remove',
          TransactionID: Options.TransactionID ?? randomUUID(),
          ActorSource: Options.ActorSource ?? null,
          ActorCharacterID: Options.ActorCharacterID ?? null,
          ActorAccountID: Options.ActorAccountID ?? null,
          ItemTypeID: Row.ItemTypeID,
          Quantity: 1,
          UniqueSerial: Row.UniqueSerial,
          FromInventoryID: InventoryID,
          FromSlotIndex: SlotIndex,
          Reason: Options.Reason ?? null,
        },
        T,
      );
      return { Outcome: 'Ok', RemovedCount: 1 };
    }

    const Current = Row.StackQuantity ?? 0;
    if (Quantity > Current) return { Outcome: 'NotEnoughQuantity' };
    const NewQty = Current - Quantity;
    if (NewQty === 0) {
      await this.Repo.DeleteItem(Row.ID, T);
    } else {
      const NewWeight = (Type.WeightGrams * NewQty).toFixed(2);
      await this.Repo.SaveItem(
        Row.ID,
        { StackQuantity: NewQty, WeightGrams: NewWeight },
        T,
      );
    }
    await this.MutationLog.Append(
      {
        Action: Options.Action ?? 'Remove',
        TransactionID: Options.TransactionID ?? randomUUID(),
        ActorSource: Options.ActorSource ?? null,
        ActorCharacterID: Options.ActorCharacterID ?? null,
        ActorAccountID: Options.ActorAccountID ?? null,
        ItemTypeID: Row.ItemTypeID,
        Quantity,
        UniqueSerial: Row.UniqueSerial,
        FromInventoryID: InventoryID,
        FromSlotIndex: SlotIndex,
        Reason: Options.Reason ?? null,
      },
      T,
    );
    return { Outcome: 'Ok', RemovedCount: Quantity };
  }

  /**
   * Per-domain serial mint. Centralised here so the AddItem path
   * stays clean and future identifier domains plug in without
   * touching the add loop.
   */
  private async MintSerial(Domain: ItemTypeDefinition['SerialDomain']): Promise<string | null> {
    switch (Domain) {
      case 'Weapon':
        return await this.Identifiers.MintWeaponSerial();
      case 'Phone':
        return await this.Identifiers.MintPhoneNumber();
      case 'License':
        return await this.Identifiers.MintLicenseNumber('License');
      case 'Document':
        return await this.Identifiers.MintDocumentSerial();
      case 'Radio':
        return await this.Identifiers.MintRadioFrequency();
      default:
        return null;
    }
  }

  /**
   * Apply a consumable's effects after a successful UseItem. Both
   * stats are true read-modify-writes against the server-replicated
   * ped state (GET_ENTITY_HEALTH / GET_PED_ARMOUR are apiset-server):
   *
   *   - Armour writes land directly via SET_PED_ARMOUR.
   *   - HP has no server-side setter, so the computed absolute target
   *     round-trips through InjuryApply for the client to apply.
   *
   * This replaces the Phase 1 "+75 approximation" - a bandage now
   * heals `current + delta` clamped to 100, so using one at full
   * health is a no-op instead of a free full heal.
   */
  ApplyConsumableEffects(Source: number, Effects: ConsumableEffects): void {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return;
      if (Effects.ApDelta !== 0) {
        const RawArmour = GetPedArmour(Ped);
        const CurrentArmour = Number.isFinite(RawArmour) ? RawArmour : 0;
        // Settle any pending comedown against the pre-write armour
        // first: every point lost since the grant already charged the
        // high once, and without the settle a body-armor top-up after
        // combat would hand the comedown legitimate plate to strip.
        const Pending = this.ApComedowns.get(Source);
        if (Pending !== undefined && Pending.Amount > CurrentArmour) {
          Pending.Amount = CurrentArmour;
          if (Pending.Amount <= 0) {
            clearTimeout(Pending.Handle);
            this.ApComedowns.delete(Source);
          }
        }
        const NewArmour = Math.max(0, Math.min(100, CurrentArmour + Effects.ApDelta));
        SetPedArmour(Ped, NewArmour);
        // The comedown owes back what actually landed, not the
        // nominal delta - a grant clamped by the armour ceiling must
        // not later strip plate the high never provided.
        const Granted = NewArmour - CurrentArmour;
        if (Granted !== 0) this.ArmourFactSink?.(Source, Granted);
        if (
          Effects.ApDecayDelaySec !== undefined &&
          Effects.ApDecayDelaySec > 0 &&
          Granted > 0
        ) {
          this.ScheduleApComedown(Source, Granted, Effects.ApDecayDelaySec);
        }
      }
      if (Effects.HpDelta !== 0) {
        // Engine range 100..200 with 100 as the alive floor; the
        // character column is the engine value minus 100. Floor the
        // target at 1 so a negative delta can never route an
        // instant-kill around the injury state machine.
        const RawHealth = GetEntityHealth(Ped);
        const CurrentHp = Number.isFinite(RawHealth)
          ? Math.max(0, Math.min(100, RawHealth - 100))
          : 0;
        const Target = Math.max(1, Math.min(100, CurrentHp + Effects.HpDelta));
        this.EmitInjuryApply(Source, { HP: Target });
      }
      if (
        Effects.RegenPerSec !== undefined &&
        Effects.RegenDurationSec !== undefined &&
        Effects.RegenPerSec > 0 &&
        Effects.RegenDurationSec > 0
      ) {
        this.StartRegen(
          Source,
          Effects.RegenPerSec,
          Effects.RegenDurationSec,
          Effects.RegenTotalHp,
        );
      }
    } catch (Err: unknown) {
      this.Log.Warn(`ApplyConsumableEffects failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * Stamp a type's use cooldown after the command layer finishes a
   * deferred-cost use (the breath test: the service branch only
   * checks the cooldown, and the stamp lands here once the subject
   * has validated, so a failed validation costs nothing).
   */
  StampUseCooldown(Source: number, ItemTypeID: string): void {
    const Type = GetItemType(ItemTypeID);
    this.UseCooldowns.set(`${Source}:${ItemTypeID}`, {
      ExpiresAt: Date.now() + (Type?.OnUseCooldownMs ?? 5_000),
    });
  }

  /**
   * Cooldown gate shared by the deferred-cost device branches (breath
   * tester, sample tester, identity document): returns an OnCooldown
   * result when a wait is still pending, or null when the use may
   * proceed. The stamp itself lands later via StampUseCooldown once the
   * command layer validates its target.
   */
  private PendingUseCooldown(Source: number, ItemTypeID: string): InventoryUseResult | null {
    const Existing = this.UseCooldowns.get(`${Source}:${ItemTypeID}`);
    const Now = Date.now();
    if (Existing !== undefined && Existing.ExpiresAt > Now) {
      return {
        Outcome: 'OnCooldown',
        Detail: `Wait ${Math.ceil((Existing.ExpiresAt - Now) / 1000)} more second(s).`,
      };
    }
    return null;
  }

  /**
   * Reveal a drug slot's normally-hidden potency metadata for the
   * narcotics test kit. Reads the target slot in the caller's own
   * inventory; refuses non-drug items (NotTestable) and empty / unknown
   * slots (NotFound). The kit is the purpose-built device the hidden-key
   * rule defers to, so Purity / THC / CBD are surfaced here even though
   * /item inspect and the ground examine never show them.
   */
  async ReadSampleReadout(Source: number, TargetSlotIndex: number): Promise<SampleReadout> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.CharacterID === null) return { Outcome: 'NotFound' };
    const Inv = await this.Repo.GetOrCreateForCharacter(PlayerState.CharacterID);
    const Items = await this.Repo.LoadItems(Inv.ID);
    const Row = Items.find((R) => R.SlotIndex === TargetSlotIndex);
    if (Row === undefined) return { Outcome: 'NotFound' };
    const Type = GetItemType(Row.ItemTypeID);
    if (Type === undefined) return { Outcome: 'NotFound' };
    if (Type.IsDrug !== true) return { Outcome: 'NotTestable', ItemName: Type.DisplayName };
    const Readout: SampleReadout = { Outcome: 'Ok', ItemName: Type.DisplayName };
    if (Row.MetadataJson !== null) {
      try {
        const Parsed = JSON.parse(Row.MetadataJson) as Record<string, unknown>;
        const Quality = Parsed[MetadataKeys.Quality];
        if (typeof Quality === 'string') Readout.Quality = Quality;
        const Purity = Parsed[MetadataKeys.Purity];
        if (typeof Purity === 'number') Readout.Purity = Purity;
        const Strain = Parsed[MetadataKeys.StrainType];
        if (typeof Strain === 'string') Readout.StrainType = Strain;
        const Thc = Parsed[MetadataKeys.ThcPercent];
        if (typeof Thc === 'number') Readout.ThcPercent = Thc;
        const Cbd = Parsed[MetadataKeys.CbdPercent];
        if (typeof Cbd === 'number') Readout.CbdPercent = Cbd;
      } catch {
        // Malformed metadata - report the name alone rather than throw.
      }
    }
    return Readout;
  }

  /**
   * True when the character's top-level inventory holds at least one of
   * `ItemTypeID`. Used as the radio possession gate at power-on; the
   * cheap top-level scan is enough (a radio buried in a container is not
   * "in hand"), and keeps the per-transmission path off the database.
   */
  async HasItemType(CharacterID: string, ItemTypeID: string): Promise<boolean> {
    // Read-only probe: GetByOwner rather than GetOrCreate, so asking
    // "do they have a radio" cannot materialise an inventory row as a
    // side effect, and an indexed single-row lookup rather than loading
    // every item (metadata blobs included) to run `.some()` over it.
    // The radio possession sweep runs this per powered-on player on a
    // timer, so the difference is recurring, not one-off.
    const Inv = await this.Repo.GetByOwner('Character', CharacterID);
    if (Inv === null) return false;
    return await this.Repo.HasItemType(Inv.ID, ItemTypeID);
  }

  // ── Phone surface ──────────────────────────────────────────────────
  // The phone system addresses handsets by their serial (= phone number).
  // These are the single source of truth for "who holds number N" and for
  // reading/mutating a handset's metadata under the inventory lock. Phone
  // identity is NEVER taken from BoundCharacterID (stale after a drop).

  /**
   * The CharacterID that currently HOLDS the handset whose serial is
   * `Serial`, walking up container parents so a phone in a backpack still
   * resolves to its carrier. Null when the serial is unknown, on the
   * ground (serial nulled while grounded), or stored in a non-character
   * surface (vehicle/property). Depth-capped against a corrupt chain.
   */
  async ResolveCharacterForSerial(Serial: string): Promise<string | null> {
    const Row = await this.Repo.FindByUniqueSerial(Serial);
    if (Row === null) return null;
    let Inv = await this.Repo.FindByID(Row.InventoryID);
    for (let Depth = 0; Depth < 8 && Inv !== null; Depth += 1) {
      if (Inv.OwnerType === 'Character') return Inv.OwnerID;
      if (Inv.OwnerType !== 'Container') return null;
      const Parent = await this.ResolveContainerParent(Inv.ID);
      if (Parent === null) return null;
      Inv = Parent.Inventory;
    }
    return null;
  }

  /**
   * Every phone NUMBER (serial) a character currently holds - top-level
   * and nested inside carried containers. The set used both to deliver to
   * a holder and to authorize a holder's reads of their own history, so
   * the two can never disagree. Cycle/depth guarded.
   */
  async ListHeldPhoneNumbers(CharacterID: string): Promise<string[]> {
    const Inv = await this.Repo.GetByOwner('Character', CharacterID);
    if (Inv === null) return [];
    const Numbers: string[] = [];
    const Seen = new Set<string>();
    const Queue: string[] = [Inv.ID];
    while (Queue.length > 0 && Seen.size < 64) {
      const InvID = Queue.shift();
      if (InvID === undefined || Seen.has(InvID)) continue;
      Seen.add(InvID);
      // Three-column projection: this walk reads type, serial and the
      // nested-inventory pointer only. Every /phone subcommand resolves
      // the active handset through here, and a player carrying a few
      // containers was pulling full rows - metadata blobs and all - for
      // each one just to look at three fields.
      const Items = await this.Repo.LoadItemsForSerialWalk(InvID);
      for (const Item of Items) {
        if (GetItemType(Item.ItemTypeID)?.SerialDomain === 'Phone' && Item.UniqueSerial !== null) {
          Numbers.push(Item.UniqueSerial);
        }
        if (Item.ContainerInventoryID !== null) Queue.push(Item.ContainerInventoryID);
      }
    }
    return Numbers;
  }

  /** Read-only handset state for a number, or null when the serial is unknown. */
  async GetPhoneMetadata(Serial: string): Promise<PhoneMetadata | null> {
    const Row = await this.Repo.FindByUniqueSerial(Serial);
    if (Row === null) return null;
    return NormalizePhoneMetadata(ParseMetadata(Row.MetadataJson));
  }

  /**
   * Clobber-safe read-modify-write of a handset's metadata: acquires the
   * owning inventory's lock, re-reads the row inside the window, applies
   * `Mutator`, and persists the whole `Phone` blob. Returns the updated
   * metadata, or null when the serial is unknown. Use for power, contacts
   * and credit top-ups; use ChargePhoneCredits for the gated debit.
   */
  async UpdatePhoneMetadata(
    Serial: string,
    Mutator: (Meta: PhoneMetadata) => void,
  ): Promise<PhoneMetadata | null> {
    const Located = await this.Repo.FindByUniqueSerial(Serial);
    if (Located === null) return null;
    const Release = await this.Lock.Acquire(Located.InventoryID);
    try {
      const Fresh = await this.Repo.FindItemByID(Located.ID);
      if (Fresh === null) return null;
      const Meta = NormalizePhoneMetadata(ParseMetadata(Fresh.MetadataJson));
      Mutator(Meta);
      await this.Repo.MergeMetadata(Fresh.ID, { [PhoneMetadataKey]: Meta });
      return Meta;
    } finally {
      Release();
    }
  }

  /**
   * Atomic gate-and-debit: under the inventory lock, refuse (return false)
   * when the handset cannot cover `Cost`, otherwise subtract it. Never
   * writes a negative balance, and the check + write are one locked step
   * so two concurrent sends cannot both pass the gate.
   */
  async ChargePhoneCredits(Serial: string, Cost: number): Promise<boolean> {
    const Located = await this.Repo.FindByUniqueSerial(Serial);
    if (Located === null) return false;
    const Release = await this.Lock.Acquire(Located.InventoryID);
    try {
      const Fresh = await this.Repo.FindItemByID(Located.ID);
      if (Fresh === null) return false;
      const Meta = NormalizePhoneMetadata(ParseMetadata(Fresh.MetadataJson));
      if (Meta.CreditsCents < Cost) return false;
      Meta.CreditsCents -= Cost;
      await this.Repo.MergeMetadata(Fresh.ID, { [PhoneMetadataKey]: Meta });
      return true;
    } finally {
      Release();
    }
  }

  /**
   * Put `Cents` back on a handset. The counterpart to
   * ChargePhoneCredits for the narrow case where a charge succeeded but
   * the thing it paid for did not happen - a call answered into a
   * caller who dropped mid-charge, say. Silent no-op when the handset
   * has since vanished; a refund that cannot be delivered must never
   * throw into the teardown path that requested it.
   */
  async RefundPhoneCredits(Serial: string, Cents: number): Promise<void> {
    if (!Number.isFinite(Cents) || Cents <= 0) return;
    const Located = await this.Repo.FindByUniqueSerial(Serial);
    if (Located === null) return;
    const Release = await this.Lock.Acquire(Located.InventoryID);
    try {
      const Fresh = await this.Repo.FindItemByID(Located.ID);
      if (Fresh === null) return;
      const Meta = NormalizePhoneMetadata(ParseMetadata(Fresh.MetadataJson));
      Meta.CreditsCents += Cents;
      await this.Repo.MergeMetadata(Fresh.ID, { [PhoneMetadataKey]: Meta });
    } finally {
      Release();
    }
  }

  /**
   * Wire the anti-cheat scanner's sanctioned-HP-adjustment hook
   * (Scanner.NoteServerHpAdjustment). Attached late from Bootstrap -
   * the scanner is constructed after the inventory cluster - mirroring
   * InjuryService.SetHealSink. The service stays fully functional
   * without it; regen simply goes unregistered, which only matters
   * while a GodModeHealth hit window is open.
   */
  SetHpAdjustmentSink(Sink: (Source: number, HpDelta: number) => void): void {
    this.HpAdjustmentSink = Sink;
  }

  /**
   * Wire the scanner's server-fact hook
   * (Scanner.NoteServerCombinedFact) for authoritative armour
   * movement - grants and comedown drains. Same late-attach pattern
   * as the HP sink; see the ArmourFactSink field for why the two
   * must not share a path.
   */
  SetArmourFactSink(Sink: (Source: number, CombinedDelta: number) => void): void {
    this.ArmourFactSink = Sink;
  }

  /**
   * Arm (or merge into) the stimulant comedown. When it fires, the
   * outstanding owed armour drains back out - read LIVE from the map
   * entry, because every later server armour write settles the owed
   * amount against pre-write armour (damage that already ate the
   * high is never double-charged, even across a body-armor top-up) -
   * and the drop registers as a server FACT (baseline shift), since
   * armour writes are apiset-server: no client round-trip exists to
   * forge or drop, so there is nothing to reconcile.
   */
  private ScheduleApComedown(Source: number, Amount: number, DelaySec: number): void {
    const Existing = this.ApComedowns.get(Source);
    const Merged = Math.min(100, (Existing?.Amount ?? 0) + Amount);
    if (Existing !== undefined) clearTimeout(Existing.Handle);
    const Handle = setTimeout((): void => {
      const Entry = this.ApComedowns.get(Source);
      this.ApComedowns.delete(Source);
      const Owed = Entry?.Amount ?? 0;
      if (Owed <= 0) return;
      try {
        const Ped = GetPlayerPed(String(Source));
        if (Ped === 0) return;
        const RawArmour = GetPedArmour(Ped);
        const CurrentArmour = Number.isFinite(RawArmour) ? RawArmour : 0;
        const Drop = Math.min(Owed, CurrentArmour);
        if (Drop <= 0) return;
        SetPedArmour(Ped, CurrentArmour - Drop);
        this.ArmourFactSink?.(Source, -Drop);
      } catch (Err: unknown) {
        this.Log.Warn(`ApComedown failed source=${Source}`, { Err: String(Err) });
      }
    }, DelaySec * 1_000);
    this.ApComedowns.set(Source, { Amount: Merged, Handle });
  }

  /**
   * Open a consumable HP-regen window and arm the shared ticker. The
   * interval lives only while at least one window does - an idle
   * server runs no regen timer at all. The window is a TICK counter,
   * not a wall-clock deadline: a deadline silently eats the final
   * tick whenever the interval was armed in the same instant (the
   * k-th fire lands at/after the deadline), making the medkit heal
   * 70 or 75 depending on whether an unrelated player happened to be
   * regenning - the counter delivers exactly DurationSec emission
   * opportunities every time.
   *
   * One window per source, strongest wins: a new use takes the slot
   * only when its budget exceeds the active window's remaining heal,
   * so smoking a joint seconds into a medkit cannot silently discard
   * sixty pending HP. TotalHp defaults to rate x ticks (the medkit
   * path); the drug branch passes its potency-scaled budget.
   */
  private StartRegen(
    Source: number,
    PerSec: number,
    DurationSec: number,
    TotalHp?: number,
  ): void {
    const Ticks = Math.max(1, Math.round((DurationSec * 1_000) / RegenTickIntervalMs));
    const Budget = Math.min(TotalHp ?? PerSec * Ticks, PerSec * Ticks);
    const Existing = this.RegenWindows.get(Source);
    if (Existing !== undefined) {
      const ExistingRemaining = Math.min(
        Existing.TotalLeft,
        Existing.PerSec * Existing.TicksLeft,
      );
      if (ExistingRemaining >= Budget) return;
    }
    this.RegenWindows.set(Source, { PerSec, TicksLeft: Ticks, TotalLeft: Budget });
    if (this.RegenInterval === null) {
      this.RegenInterval = setInterval((): void => {
        this.TickRegen();
      }, RegenTickIntervalMs);
    }
  }

  /**
   * One regen sweep. Per window:
   *
   *   - Expired, disconnected, or no-longer-Healthy sources drop out;
   *     a regen window must never fight the injury machine's clamp on
   *     a freshly downed ped.
   *   - The delta rides InjuryRegenTick as a RELATIVE adjustment for
   *     the same reason the bleeding drain does: an absolute target
   *     computed from the server's replicated read would race
   *     concurrent gunfire and erase damage dealt in flight. Clamped
   *     against the replicated HP so the final tick cannot instruct
   *     past 100 even before the client's own ceiling applies.
   *   - Every emitted rise registers with the scanner sink so an open
   *     GodModeHealth window attributes it (ReconcileSanctionedDelta)
   *     instead of closing on a phantom heal.
   *   - A ped already at full HP consumes the tick without emitting:
   *     the window spans a fixed stretch of wall time and skipped
   *     ticks are lost, which is the "over a short window" the item
   *     description sells - not a bank of deferred healing.
   */
  private TickRegen(): void {
    for (const [Source, Window] of this.RegenWindows) {
      const PlayerState = this.State.Get(Source);
      if (PlayerState === null || PlayerState.Phase !== 'Spawned') {
        this.RegenWindows.delete(Source);
        continue;
      }
      const Runtime = this.Runtimes.Get(Source);
      if (Runtime === null || Runtime.InjuryStatus !== 'Healthy') {
        this.RegenWindows.delete(Source);
        continue;
      }
      try {
        const Ped = GetPlayerPed(String(Source));
        if (Ped !== 0) {
          const RawHealth = GetEntityHealth(Ped);
          const ColumnHp = Number.isFinite(RawHealth)
            ? Math.max(0, Math.min(100, RawHealth - 100))
            : 100;
          const Budget = Math.min(Window.PerSec, Window.TotalLeft);
          const HpDelta = Math.min(Budget, 100 - ColumnHp);
          if (HpDelta > 0) {
            const Payload: NetEventPayloads[typeof NetEvents.InjuryRegenTick] = { HpDelta };
            emitNet(NetEvents.InjuryRegenTick, Source, Payload);
            this.HpAdjustmentSink?.(Source, HpDelta);
          }
          // The budget burns by the offered amount whether or not the
          // ped had headroom - the window spans wall time and skipped
          // ticks are lost, not banked.
          Window.TotalLeft -= Budget;
        }
      } catch (Err: unknown) {
        this.Log.Warn(`TickRegen failed source=${Source}`, { Err: String(Err) });
      }
      Window.TicksLeft -= 1;
      if (Window.TicksLeft <= 0 || Window.TotalLeft <= 0) this.RegenWindows.delete(Source);
    }
    if (this.RegenWindows.size === 0 && this.RegenInterval !== null) {
      clearInterval(this.RegenInterval);
      this.RegenInterval = null;
    }
  }

  /**
   * Emit `InjuryApply` to a single Source. Wrapper around `emitNet`
   * so the InventoryService stays the only caller of the engine
   * primitive from the inventory surface.
   */
  private EmitInjuryApply(
    Source: number,
    Payload: NetEventPayloads[typeof NetEvents.InjuryApply],
  ): void {
    try {
      emitNet(NetEvents.InjuryApply, Source, Payload);
    } catch (Err: unknown) {
      this.Log.Warn(`EmitInjuryApply failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * On spawn, issue any permanent item the character is missing.
   *
   * Idempotent - held types are skipped - so it runs safely on every
   * spawn. Driven off the catalog's IsPermanent flag rather than a list,
   * so a newly-flagged type enrols automatically for existing characters.
   */
  private async RegrantPermanents(
    Source: number,
    CharacterID: string,
    Inv: Inventory,
  ): Promise<void> {
    void Source;
    const Permanents = PermanentTypeIDs();
    if (Permanents.length === 0) return;
    const Held = await this.Repo.HeldPermanentTypeIDs(Inv.ID, Permanents);
    for (const TypeID of Permanents) {
      if (Held.has(TypeID)) continue;
      const Result = await this.AddItem(Inv.ID, TypeID, 1, {
        BoundCharacterID: CharacterID,
        Reason: 'Permanent re-grant on spawn',
      });
      if (Result.Outcome !== 'Ok') {
        this.Log.Warn(
          `Permanent re-grant failed character=${CharacterID} type=${TypeID}`,
          { Outcome: Result.Outcome, Detail: Result.Detail ?? '' },
        );
      }
    }
  }

  // Helper exposed to admin paths for currency totals.
  /**
   * Total carried cash in cents, summed across denomination rows - there
   * is no balance column, since paper currency is ordinary items.
   */
  CountCurrencyCentsForCharacter(CharacterID: string): Promise<number> {
    return this.Repo.CountCurrencyCentsForCharacter(CharacterID);
  }

  // Helper for command-side rendering.
  /** Render cents as a display string. Exact - never rounds, unlike ChatFormatter.Money. */
  FormatCash(Cents: number): string {
    return FormatCashCents(Cents);
  }

  /**
   * Re-issue a permanent item after a mid-session admin removal.
   *
   * Idempotent - no-ops if the character already holds one, and ignores
   * non-permanent types entirely. This is what stops `/aitem remove`
   * permanently breaking a character by taking their phone or ID card.
   */
  async ReGrantIfPermanent(
    CharacterID: string,
    ItemTypeID: string,
  ): Promise<void> {
    const Type = GetItemType(ItemTypeID);
    if (Type?.IsPermanent !== true) return;
    const Inv = await this.Repo.GetOrCreateForCharacter(CharacterID);
    const Held = await this.Repo.HeldPermanentTypeIDs(Inv.ID, [ItemTypeID]);
    if (Held.has(ItemTypeID)) return;
    await this.AddItem(Inv.ID, ItemTypeID, 1, {
      BoundCharacterID: CharacterID,
      Reason: 'Permanent re-grant after admin removal',
    });
  }
}

/**
 * Canonical JSON serialisation: keys sorted alphabetically at every
 * depth so byte-for-byte stack-merge equality is structural rather
 * than insertion-order dependent.
 */
function SerialiseMetadata(Meta?: Record<string, unknown>): string | null {
  if (Meta === undefined) return null;
  return JSON.stringify(CanonicalOrder(Meta));
}

/**
 * Recursively sort object keys so two structurally-equal metadata objects
 * serialise to identical strings.
 *
 * This is what makes stack merging correct: two items merge only when
 * their metadata matches byte-for-byte, and without canonical ordering
 * `{A:1,B:2}` and `{B:2,A:1}` would compare as different and refuse to
 * stack. Array order is meaningful and is preserved.
 */
function CanonicalOrder(Value: unknown): unknown {
  if (Array.isArray(Value)) return Value.map(CanonicalOrder);
  if (Value === null || typeof Value !== 'object') return Value;
  const Sorted: Record<string, unknown> = {};
  for (const Key of Object.keys(Value).sort()) {
    Sorted[Key] = CanonicalOrder((Value as Record<string, unknown>)[Key]);
  }
  return Sorted;
}

/** Catalog IDs flagged `IsPermanent: true`. Populated as features ship. */
function PermanentTypeIDs(): string[] {
  // Derived from the catalog so a new IsPermanent type (licenses, the
  // state ID card) enrols in the spawn re-grant automatically
  // (decision 33).
  return Object.values(ItemTypes)
    .filter((Type) => Type.IsPermanent === true)
    .map((Type) => Type.ID);
}

/** Parse a row's metadata blob into a working object, returning {} on null/malformed. */
function ParseMetadata(Json: string | null): Record<string, unknown> {
  if (Json === null) return {};
  try {
    const Parsed = JSON.parse(Json) as Record<string, unknown>;
    return typeof Parsed === 'object' && Parsed !== null ? Parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the FIFO magazine queue out of a weapon's metadata, skipping
 * malformed segments.
 *
 * Order is load-bearing - the head is the next round fired - so segments
 * are kept in sequence rather than merged or sorted. Same defensive
 * posture as ReadAttachedComponents.
 */
function ReadLoadedAmmo(Metadata: Record<string, unknown>): LoadedAmmoSegment[] {
  const Raw = Metadata.LoadedAmmo;
  if (!Array.isArray(Raw)) return [];
  const Out: LoadedAmmoSegment[] = [];
  for (const Item of Raw) {
    if (
      typeof Item !== 'object' ||
      Item === null ||
      typeof (Item as { ItemTypeID?: unknown }).ItemTypeID !== 'string' ||
      typeof (Item as { Qty?: unknown }).Qty !== 'number'
    ) {
      continue;
    }
    const Cast = Item as { ItemTypeID: string; Qty: number; CustomName?: string };
    const Segment: LoadedAmmoSegment = {
      ItemTypeID: Cast.ItemTypeID,
      Qty: Math.floor(Cast.Qty),
    };
    if (Cast.CustomName !== undefined) Segment.CustomName = Cast.CustomName;
    Out.push(Segment);
  }
  return Out;
}

/**
 * Decide whether `IncomingMetadata` can merge into the row with the
 * given persisted JSON. Non-blendable keys must be byte-for-byte
 * equal; blendable keys are always allowed (they weighted-average).
 */
function CanStackMerge(
  RowMetadataJson: string | null,
  IncomingMetadata: Record<string, unknown>,
  BlendableKeys: Set<string>,
): boolean {
  const Row = RowMetadataJson === null ? {} : ParseMetadata(RowMetadataJson);
  const Keys = new Set<string>([...Object.keys(Row), ...Object.keys(IncomingMetadata)]);
  for (const Key of Keys) {
    if (BlendableKeys.has(Key)) continue;
    if (JSON.stringify(Row[Key] ?? null) !== JSON.stringify(IncomingMetadata[Key] ?? null)) {
      return false;
    }
  }
  return true;
}

/**
 * Weighted-average blend of blendable numeric keys. Non-blendable
 * keys take the row's existing value (the byte-for-byte match
 * guaranteed they were identical before).
 *
 *   new_value = (qty_a * value_a + qty_b * value_b) / (qty_a + qty_b)
 *
 * Result rounds to 4 decimal places (decision 27).
 */
function BlendMetadata(
  RowMetadata: Record<string, unknown>,
  IncomingMetadata: Record<string, unknown>,
  BlendableKeys: Set<string>,
  RowQty: number,
  AddedQty: number,
): Record<string, unknown> {
  const Out: Record<string, unknown> = { ...RowMetadata };
  for (const Key of BlendableKeys) {
    const RowValue = RowMetadata[Key];
    const IncomingValue = IncomingMetadata[Key];
    if (typeof IncomingValue !== 'number' && typeof RowValue !== 'number') continue;
    const A = typeof RowValue === 'number' ? RowValue : 0;
    const B = typeof IncomingValue === 'number' ? IncomingValue : 0;
    const Total = RowQty + AddedQty;
    if (Total <= 0) continue;
    const Blended = (RowQty * A + AddedQty * B) / Total;
    Out[Key] = Math.round(Blended * 10_000) / 10_000;
  }
  // Bring across any non-blendable keys that incoming carries but row
  // does not. Per CanStackMerge these were equal-or-absent on the row
  // side, so writing them here just ensures the metadata stays complete.
  for (const Key of Object.keys(IncomingMetadata)) {
    if (BlendableKeys.has(Key)) continue;
    if (!(Key in Out)) Out[Key] = IncomingMetadata[Key];
  }
  return Out;
}

/**
 * Strip chat tokens `!{...}` and HTML-style brackets `<...>` from a
 * candidate name / description; collapse internal whitespace and
 * trim. Returns the sanitised result (may be empty).
 */
function SanitiseNameRequest(Raw: string): string {
  return Raw
    .replace(/!\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read the fitted-component list out of a weapon's metadata, tolerating
 * anything malformed by skipping it rather than throwing.
 *
 * Metadata is persisted JSON that has survived migrations and admin
 * `/aitem create` payloads, so a defensive read is the difference between
 * one bad row and an unequippable weapon.
 */
function ReadAttachedComponents(Metadata: Record<string, unknown>): AttachedComponent[] {
  const Raw = Metadata.AttachedComponents;
  if (!Array.isArray(Raw)) return [];
  const Out: AttachedComponent[] = [];
  for (const Item of Raw) {
    if (
      typeof Item !== 'object' ||
      Item === null ||
      typeof (Item as { ItemTypeID?: unknown }).ItemTypeID !== 'string' ||
      typeof (Item as { ComponentHash?: unknown }).ComponentHash !== 'number' ||
      typeof (Item as { AttachmentSlot?: unknown }).AttachmentSlot !== 'string'
    ) {
      continue;
    }
    const Cast = Item as {
      ItemTypeID: string;
      ComponentHash: number;
      AttachmentSlot: AttachmentSlot;
    };
    // ItemTypeID is the durable identity; the hash is re-resolved
    // from the catalog on every read so rows persisted under a
    // since-corrected catalog hash heal themselves. The stored hash
    // survives only for types dropped from the catalog.
    const CompType = GetItemType(Cast.ItemTypeID);
    Out.push({
      ItemTypeID: Cast.ItemTypeID,
      ComponentHash: CompType?.ComponentHash ?? Cast.ComponentHash,
      AttachmentSlot: Cast.AttachmentSlot,
    });
  }
  return Out;
}
