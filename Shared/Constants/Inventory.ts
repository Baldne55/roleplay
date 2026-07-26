/**
 * Inventory constants shared between Backend and Frontend.
 *
 * The polymorphic-owner inventory model: every storage surface in the
 * game (a character's pockets, a backpack's inner inventory, a vehicle
 * trunk later, a property safe later, a business stash later) is one
 * row in the `inventories` table, discriminated by `OwnerType`. The
 * `inventory_items` table carries one row per item instance, with
 * stackables merging on (ItemTypeID + MetadataJson + CustomName)
 * byte-for-byte.
 *
 * Ground drops live in their own `ground_drops` table - no slot grid,
 * every drop carries its world coord.
 *
 * Slot indexing is **0-based** everywhere internally (DB rows, service
 * APIs). The chat layer presents 1-based labels (Slot 1, Slot 2, ...);
 * the conversion happens at the command boundary.
 */

import { ChatRanges } from '../Chat/Index.js';

/**
 * Polymorphic inventory owners. Only Character and Container land in
 * Phase 1; VehicleTrunk / VehicleGlovebox / Property / Business are
 * reserved for later slices and the service layer rejects them with
 * `OwnerTypeNotSupported` until those features land.
 *
 * Ground is included for symmetry - the ground_drops table is its own
 * surface but the OwnerType union covers every place an item can live.
 */
export const OwnerTypes = [
  'Character',
  'Container',
  'VehicleTrunk',
  'VehicleGlovebox',
  'Property',
  'Business',
  'Ground',
] as const;
/** What owns an inventory - a character, or a container item's inner storage. */
export type OwnerType = (typeof OwnerTypes)[number];

/** Phase 1 + Phase 3 supported owners (Phase 2 adds Ground via dedicated table). */
export const SupportedOwnerTypes: readonly OwnerType[] = ['Character', 'Container', 'Ground'];

/** Default slot count for a freshly created character. */
export const DefaultCharacterSlotCapacity = 20;

/** Default carry-weight cap for a freshly created character (decimal grams). */
export const DefaultCharacterWeightCapacityGrams = 20_000.0;

/** Starter cash granted at character creation, in integer cents ($5,000.00). */
export const CashStarterCents = 500_000;

/** Conversion factor for dollars <-> cents. */
export const CashCentsPerDollar = 100;

/**
 * The currency type minted by system credit paths (starter grant,
 * payroll, admin give). Reads and debits walk every `IsCurrency` type;
 * only the *grant* side needs one canonical denomination.
 */
export const CanonicalCurrencyTypeID = 'cash';

/**
 * Maximum cents per `cash` item stack: $100,000.00 per stack. With the
 * 20-slot character cap that yields a $2M cash carry ceiling. The bank
 * slice will handle large balances; carrying paper currency is
 * intentionally constrained.
 */
export const CashMaxStackCents = 10_000_000;

/**
 * Replicated state-bag key carrying the equipped-weapon projection
 * (`EquippedWeaponBag` on the Backend). The server writes it on every
 * equip / unequip / reload / shot-pop; the Frontend ammo poll keys its
 * lifecycle off the bag transitions.
 */
export const EquippedWeaponBagKey = 'Roleplay:EquippedWeapon';

/** 30-second backstop for the inventory async-lock queue. */
export const InventoryLockTimeoutMs = 30_000;

/** Per-Source mutation rate-limit (token bucket): 10 mutations/sec. */
export const InventoryMutationRateLimit = { Capacity: 10, RefillPerSecond: 10 } as const;

/** Per-Source read rate-limit (token bucket): burst 20, 10/sec sustained. */
export const InventoryReadRateLimit = { Capacity: 20, RefillPerSecond: 10 } as const;

/** Ground-drop range for `/item drop` (foot coord placement) and `/item pickup` (proximity gate). */
export const GroundDropRangeMeters = 3;

/** IC handover range for `/item give` (player-to-player transfer). */
export const HandoverRangeMeters = 3;

/** Pickup proximity gate; matches drop. */
export const PickupRangeMeters = 3;

/** `/item nearby` listing radius - reuses `/low` chat scope so the player learns one distance. */
export const NearItemsRangeMeters = ChatRanges.Low;

/** Default placeholder model for ground drops when the item type does not override. */
export const PlaceholderGroundProp = 'prop_money_bag_01';

/** Label height offset above the drop coord (so the prop does not occlude the text). */
export const GroundLabelZOffset = 0.05;

/** Net-event broadcast radius for ground-drop spawn / despawn / weapon discharge events. */
export const InventoryNetBroadcastRangeMeters = 50;

/** Item-type catalog defines the absolute ceiling on a single stack quantity (sanity guard). */
export const AbsoluteStackQuantityCeiling = 10_000_000;

/**
 * Typed result outcomes for inventory mutations. Mirrors the
 * CommandResult shape so callers can switch exhaustively.
 */
export const InventoryOutcomes = [
  'Ok',
  'OutOfSlots',
  'OverWeight',
  'UnknownItemType',
  'InvalidQuantity',
  'BlacklistedCategory',
  'OwnerTypeNotSupported',
  'NotFound',
  'NotEnoughQuantity',
  'SlotOccupied',
  'NotTradeable',
  'NotDroppable',
  'ContainerNestingForbidden',
  'OnCooldown',
  'InvalidUse',
  'LockTimeout',
  'PermissionDenied',
] as const;
/** Result discriminator every inventory operation returns. Outcomes are returned, never thrown. */
export type InventoryOutcome = (typeof InventoryOutcomes)[number];

/**
 * Action enum for `inventory_mutation_log.action`. Append-only forensic
 * trail; each mutation appends one row inside the same transaction as
 * the actual write so the log can never lag the state.
 */
export const InventoryMutationActions = [
  'Add',
  'Remove',
  'Move',
  'Transfer',
  'Drop',
  'Pickup',
  'Attach',
  'Detach',
  'Deface',
  'Rebind',
  'Rename',
  'AdminGive',
  'AdminRemove',
  'AdminMint',
  'Reload',
  'WeaponShot',
  'WeaponDischarge',
] as const;
/** Mutation kind recorded in the audit log; what `/aitem history` prints per row. */
export type InventoryMutationAction = (typeof InventoryMutationActions)[number];

/**
 * Format a cash amount in integer cents as "$N,NNN,NNN.NN". Used by the
 * Backend command surface (`/cash`, `/inventory` text manifest, transfer
 * narrations) and any future UI consumer.
 */
export function FormatCashCents(Cents: number): string {
  const Dollars = Math.floor(Cents / 100);
  const Remainder = Math.abs(Cents) % 100;
  return `$${Dollars.toLocaleString('en-US')}.${Remainder.toString().padStart(2, '0')}`;
}

/**
 * Format a weight in decimal grams as "N,NNN.NNg". Matches the
 * inventory text-manifest column.
 */
export function FormatWeightGrams(Grams: number): string {
  return `${Grams.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g`;
}

/**
 * Parse a dollar argument with optional 2-decimal precision into
 * integer cents. Returns null on any malformed input (NaN, negative,
 * >2 decimal places, non-finite). Used by `/aitem give cash <amount>`
 * and `/aitem remove cash <amount>` - every other item type's <amount>
 * arg is a unit count.
 *
 *   ParseDollarsToCents('500')      -> 50_000
 *   ParseDollarsToCents('420.69')   -> 42_069
 *   ParseDollarsToCents('420.6912') -> null
 */
export function ParseDollarsToCents(Arg: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(Arg)) return null;
  const Parsed = Number.parseFloat(Arg);
  if (!Number.isFinite(Parsed) || Parsed < 0) return null;
  return Math.round(Parsed * 100);
}
