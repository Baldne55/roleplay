/**
 * Hardcoded item-type catalog. Single source of truth for every item
 * that can exist in the world - category, weight, max-stack, mutability
 * flags, and per-category behaviour fields (consumable deltas, weapon
 * hashes, container slots, ...).
 *
 * The catalog is intentionally a frozen object literal: types never
 * change at runtime, additions land here in a code change. The runtime
 * `GetItemType` accessor returns undefined for unknown IDs so the
 * caller can map that to an `UnknownItemType` outcome.
 *
 * Phase 1 shipped four types: cash + bandage + body_armor + medkit.
 * Later phases extended the catalog without schema changes:
 *   - Phase 2: the full weapon domain (every holdable weapon model,
 *              attachable components, ammunition classes, shell
 *              casings) - generated into WeaponItemTypes.ts and
 *              spread into the map below
 *   - Phase 3: ziploc_bag_small/medium, backpack_small, cocaine,
 *              marijuana, beer, whiskey, wine
 *   - Phase 4: license_driver, license_weapon, the three phone
 *              tiers (phone_ifruit, phone_badger, phone_celltowa),
 *              paper, note
 */

import { CashMaxStackCents } from './Inventory.js';
import type { DrugClass } from './Drugs.js';
import { WeaponItemTypes } from './WeaponItemTypes.js';

/** Top-level catalog grouping, used for filtering and display ordering. */
export type ItemCategory =
  | 'Currency'
  | 'Weapon'
  | 'WeaponComponent'
  | 'Ammunition'
  | 'Consumable'
  | 'Document'
  | 'License'
  | 'Key'
  | 'Tool'
  | 'Container'
  | 'Clothing'
  | 'Misc';

/** Which serial format a type mints. Absent means the type is not serialised. */
export type SerialDomain = 'Weapon' | 'Phone' | 'License' | 'Document' | 'Radio';

/**
 * One slot per engine attach-bone family, so two components that
 * exclude each other in-game land in the same slot: WAPClip ->
 * Magazine, WAPScop -> Sight, WAPSupp -> Muzzle (brakes + compensators
 * included), WAPGrip -> Grip, WAPFlshLasr -> Flashlight, WAPBarrel ->
 * Barrel, gun_root -> Skin.
 */
export type AttachmentSlot =
  | 'Magazine'
  | 'Sight'
  | 'Muzzle'
  | 'Grip'
  | 'Flashlight'
  | 'Barrel'
  | 'Skin';

/** Who may read a metadata field: everyone, only the bound holder, or nobody. */
export type MetadataVisibilityScope = 'Always' | 'OwnerOnly' | 'Never';

/**
 * The full definition for one item type. Most fields are optional so a
 * minimal entry (cash, bandage) carries no noise; specialised types
 * (weapons, containers, drugs, alcohol) opt into the fields they need.
 *
 * Field groups:
 *   - Identity:   ID, DisplayName, Description, Category
 *   - Physics:    WeightGrams, MaxStack, IsUnique
 *   - Mutability: IsTradeable, IsDroppable, IsPermanent, IsFixture
 *   - Currency:   IsCurrency, CurrencyValuePerUnit
 *   - Weapon:     IsWeapon, WeaponHash, DefaultAmmo, MaxAmmo,
 *                 MaxBurstPerEvent, IsThrowable, ShellCasingTypeID
 *   - Component:  IsWeaponComponent, ComponentHash, AttachmentSlot,
 *                 CompatibleWeaponHashes
 *   - Ammo:       IsAmmunition, CompatibleWeaponHashes
 *   - Consumable: IsConsumable, OnUseHpDelta, OnUseApDelta,
 *                 OnUseHpRegenPerSec, OnUseEffectDurationSec,
 *                 OnUseCooldownMs, OnUseBleedingRelief
 *   - Alcohol:    AlcoholPercent
 *   - Custom-name + description: AllowsCustomName, AllowsDescription
 *   - Drug:       IsDrug
 *   - Container:  IsContainer, ContainerSlots, ContainerWeightGrams,
 *                 ContainerBlacklistedCategories
 *   - Mint:       SerialDomain, IsHolderBound, IsSerialStrippable,
 *                 IsHolderRebindable
 *   - Key:        IsKey, KeyDomain
 *   - Visibility: VisibleMetadataKeys, SerialVisibility, HolderVisibility
 *   - Blendable:  BlendableMetadataKeys
 *   - World prop: WorldObjectModel
 *   - Narration:  HandoverNarration
 */
export interface ItemTypeDefinition {
  readonly ID: string;
  readonly DisplayName: string;
  readonly Description: string;
  readonly Category: ItemCategory;
  /** Decimal grams - matches the DECIMAL(8,2) column. */
  readonly WeightGrams: number;
  /** 1 for non-stackables (weapons, phones, keys); larger for stackables. */
  readonly MaxStack: number;
  /** Forbids stacking even at MaxStack > 1 (defence-in-depth flag). */
  readonly IsUnique?: boolean;
  readonly IsTradeable: boolean;
  readonly IsDroppable: boolean;
  readonly IsPermanent?: boolean;
  /** World-anchored evidence (blood splats). Spawned straight onto the
   *  ground by a system, never held by anyone: pickup paths must
   *  refuse, and the system sweep is the despawn route. */
  readonly IsFixture?: boolean;

  // ── Currency ──
  readonly IsCurrency?: boolean;
  readonly CurrencyValuePerUnit?: number;

  // ── Weapon ──
  readonly IsWeapon?: boolean;
  readonly WeaponHash?: number;
  /** When > 0, a fresh row is seeded with a self-typed LoadedAmmo
   *  segment of this size - the charge tools (jerry cans,
   *  extinguisher) spawn full. Guns declare 0 and load via reload. */
  readonly DefaultAmmo?: number;
  readonly MaxAmmo?: number;
  readonly MaxBurstPerEvent?: number;
  /** The stack is the ammunition: equip arms the ped with
   *  StackQuantity and every throw consumes one from the row. */
  readonly IsThrowable?: boolean;
  /** Casing item spawned at the shooter's feet per accepted shot;
   *  omitted for weapons that retain their casings (revolvers,
   *  break-actions, energy weapons, launchers). */
  readonly ShellCasingTypeID?: string;

  // ── Weapon component ──
  readonly IsWeaponComponent?: boolean;
  readonly ComponentHash?: number;
  readonly AttachmentSlot?: AttachmentSlot;

  // ── Ammunition + components share compatibility list ──
  readonly IsAmmunition?: boolean;
  readonly CompatibleWeaponHashes?: readonly number[];

  // ── Consumable ──
  readonly IsConsumable?: boolean;
  readonly OnUseHpDelta?: number;
  readonly OnUseApDelta?: number;
  readonly OnUseHpRegenPerSec?: number;
  readonly OnUseEffectDurationSec?: number;
  readonly OnUseCooldownMs?: number;
  /** Steps the user's BleedingStatus down one tier ('StepDown') or
   *  clears it outright ('Clear') alongside the regular consumable
   *  deltas. */
  readonly OnUseBleedingRelief?: 'StepDown' | 'Clear';

  // ── Alcohol (type-level ABV %; feeds the stored blood-alcohol
  // model in Shared/Constants/Alcohol.ts - intoxication effects
  // defer to the bar slice) ──
  readonly AlcoholPercent?: number;
  /**
   * The drinkable pour in millilitres. Kept separate from
   * WeightGrams, which deliberately includes the vessel (migration
   * 20260610000007: "drinks now count their glass") - computing
   * ethanol off the carry weight would charge a whiskey shot for the
   * tumbler around it.
   */
  readonly LiquidVolumeMl?: number;

  // ── Custom name + description opt-in ──
  readonly AllowsCustomName?: boolean;
  readonly AllowsDescription?: boolean;

  // ── IC handover narration ('Generic' default) ──
  readonly HandoverNarration?: 'TypeName' | 'Generic';

  // ── Drug dispatch ──
  readonly IsDrug?: boolean;
  /** Addiction class every use feeds (alcohol feeds 'Alcohol' via its own ingest path). */
  readonly DrugClass?: DrugClass;
  /**
   * Stat the high moves. 'AP' grants armour now and drains the grant
   * back out when the window closes (the stimulant comedown); 'HP'
   * heals across the window via the regen ticker. The amount is the
   * peak at full potency - the batch's hidden Purity / THC scales it
   * down (Shared/Constants/Drugs.ts PotencyFromMetadata).
   */
  readonly OnUseBoostStat?: 'HP' | 'AP';
  readonly OnUseBoostAmount?: number;
  readonly OnUseBoostDurationSec?: number;

  /** Breath-test device: `/item use` runs a BAC reading instead of consuming. */
  readonly IsBreathTester?: boolean;

  /**
   * Sample-analysis device (narcotics test kit): `/item use <slot>
   * <target_slot>` reveals the hidden quality / purity of a drug in the
   * target slot instead of consuming anything - the purpose-built reveal
   * device the hidden-metadata rule defers to.
   */
  readonly IsSampleTester?: boolean;

  /**
   * Identity document (ID card / licenses): `/item use <slot>
   * [player_id]` presents the holder's identity to a nearby player, or
   * to the holder when no target is given. Not consumed.
   */
  readonly IsIdentityDocument?: boolean;

  // ── Container ──
  readonly IsContainer?: boolean;
  readonly ContainerSlots?: number;
  readonly ContainerWeightGrams?: number;
  readonly ContainerBlacklistedCategories?: readonly ItemCategory[];

  // ── World prop (drops) ──
  readonly WorldObjectModel?: string;
  /** Euler rotation in degrees applied to the spawned world prop.
   *  For decal-plane props authored upright (blood splat) that must
   *  lie flat on the ground; omitted = the engine's spawn rotation. */
  readonly WorldObjectRotation?: {
    readonly Pitch: number;
    readonly Roll: number;
    readonly Yaw: number;
  };

  // ── Identifier minting ──
  readonly SerialDomain?: SerialDomain;
  readonly IsHolderBound?: boolean;
  readonly IsSerialStrippable?: boolean;
  readonly IsHolderRebindable?: boolean;

  // ── Key ──
  readonly IsKey?: boolean;
  readonly KeyDomain?: 'Vehicle' | 'Property';

  // ── Metadata visibility (anti-metagaming) ──
  readonly VisibleMetadataKeys?: readonly string[];
  readonly SerialVisibility?: MetadataVisibilityScope;
  readonly HolderVisibility?: MetadataVisibilityScope;

  // ── Blendable metadata (weighted-average on stack merge) ──
  readonly BlendableMetadataKeys?: readonly string[];

  /** Seeded into a fresh row's metadata when the creator supplies no
   *  value for a key (explicit metadata always wins). Keeps admin-given
   *  drugs carrying their Quality / Purity / strain profile - a bare
   *  row would otherwise dilute real batches toward zero on merge. */
  readonly DefaultMetadata?: Readonly<Record<string, string | number>>;
}

/**
 * Reserved metadata keys with consistent semantics across item types.
 * Item types pick which to surface via VisibleMetadataKeys. Purity /
 * *Percent / IsForged / IsStolen are HIDDEN as a hard rule - they
 * are persisted but never sent to inspecting clients. Purpose-built
 * devices (purity tester, forensic kit) will reveal them later.
 */
export const MetadataKeys = {
  Quality: 'Quality',
  Purity: 'Purity',
  StrainType: 'StrainType',
  ThcPercent: 'ThcPercent',
  CbdPercent: 'CbdPercent',
  Ammo: 'Ammo',
  LoadedAmmo: 'LoadedAmmo',
  BloodType: 'BloodType',
  AttachedComponents: 'AttachedComponents',
  Description: 'Description',
  IsForged: 'IsForged',
  IsStolen: 'IsStolen',
  VehicleID: 'VehicleID',
  PropertyID: 'PropertyID',
} as const;

/**
 * Phase 1 catalog. Four types - just enough to exercise:
 *   - Currency stacking + overflow (cash)
 *   - Immediate HP consumable (bandage)
 *   - Immediate AP consumable (body_armor)
 *   - HP-with-regen consumable (medkit; the server-driven regen
 *     ticker rides NetEvents.InjuryRegenTick)
 *
 * Phase 2-4 extend the same map without schema changes. The weapon
 * domain (weapons, components, ammunition, shell casings) lives in
 * the generated WeaponItemTypes.ts and is spread in below; every
 * hash literal there is the lowercase joaat of the canonical R* name
 * in the adjacent comment, verified computationally - never trust a
 * recalled hash literal, a wrong one makes the engine no-op silently.
 */
export const ItemTypes: Record<string, ItemTypeDefinition> = {
  ...WeaponItemTypes,

  cash: {
    ID: 'cash',
    DisplayName: 'Cash',
    Description: 'Paper currency.',
    Category: 'Currency',
    WeightGrams: 0,
    MaxStack: CashMaxStackCents,
    IsTradeable: true,
    IsDroppable: true,
    IsCurrency: true,
    CurrencyValuePerUnit: 1,
    WorldObjectModel: 'prop_anim_cash_pile_02',
  },
  bandage: {
    ID: 'bandage',
    DisplayName: 'Bandage',
    Description: 'Stops minor bleeding and restores light health.',
    Category: 'Consumable',
    WeightGrams: 50.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 25,
    OnUseCooldownMs: 5_000,
    OnUseBleedingRelief: 'StepDown',
    WorldObjectModel: 'prop_med_bag_01',
  },
  body_armor: {
    ID: 'body_armor',
    DisplayName: 'Body Armor',
    Description: 'Restores full ballistic armour.',
    Category: 'Consumable',
    WeightGrams: 3_000.0,
    MaxStack: 2,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseApDelta: 100,
    OnUseCooldownMs: 10_000,
    WorldObjectModel: 'prop_armour_pickup',
  },
  medkit: {
    ID: 'medkit',
    DisplayName: 'Medkit',
    Description: 'Restores significant health over a short window.',
    Category: 'Consumable',
    WeightGrams: 500.0,
    MaxStack: 3,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 25,
    OnUseHpRegenPerSec: 5,
    OnUseEffectDurationSec: 15,
    OnUseCooldownMs: 30_000,
    OnUseBleedingRelief: 'Clear',
    WorldObjectModel: 'prop_ld_health_pack',
  },
  painkillers: {
    ID: 'painkillers',
    DisplayName: 'Painkillers',
    Description: 'An over-the-counter bottle of analgesic tablets.',
    Category: 'Consumable',
    WeightGrams: 50.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 10,
    OnUseCooldownMs: 15_000,
    WorldObjectModel: 'prop_cs_pills',
  },
  morphine: {
    ID: 'morphine',
    DisplayName: 'Morphine Syringe',
    Description: 'A single-dose syringe of medical morphine.',
    Category: 'Consumable',
    WeightGrams: 30.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 35,
    OnUseCooldownMs: 60_000,
    WorldObjectModel: 'prop_syringe_01',
  },

  // ── Containers (Phase 3) ──
  ziploc_bag_small: {
    ID: 'ziploc_bag_small',
    DisplayName: 'Small Ziploc Bag',
    Description: 'A small resealable plastic bag.',
    Category: 'Container',
    WeightGrams: 5.0,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 1,
    ContainerWeightGrams: 100.0,
    WorldObjectModel: 'bkr_prop_weed_bag_01a',
  },
  ziploc_bag_medium: {
    ID: 'ziploc_bag_medium',
    DisplayName: 'Medium Ziploc Bag',
    Description: 'A resealable plastic bag.',
    Category: 'Container',
    WeightGrams: 10.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 2,
    ContainerWeightGrams: 500.0,
    WorldObjectModel: 'bkr_prop_weed_bag_01a',
  },
  backpack_small: {
    ID: 'backpack_small',
    DisplayName: 'Small Backpack',
    Description: 'A compact everyday backpack.',
    Category: 'Container',
    WeightGrams: 500.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 10,
    ContainerWeightGrams: 5_000.0,
    WorldObjectModel: 'prop_michael_backpack',
  },
  ziploc_bag_large: {
    ID: 'ziploc_bag_large',
    DisplayName: 'Large Ziploc Bag',
    Description: 'A large resealable plastic bag.',
    Category: 'Container',
    WeightGrams: 15.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 3,
    ContainerWeightGrams: 1_000.0,
    WorldObjectModel: 'bkr_prop_weed_bag_01a',
  },
  envelope: {
    ID: 'envelope',
    DisplayName: 'Envelope',
    Description: 'A sealed paper envelope.',
    Category: 'Container',
    WeightGrams: 5.0,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 2,
    ContainerWeightGrams: 100.0,
    ContainerBlacklistedCategories: ['Weapon', 'WeaponComponent', 'Ammunition', 'Tool', 'Container'],
    WorldObjectModel: 'prop_cs_envolope_01',
  },
  wallet: {
    ID: 'wallet',
    DisplayName: 'Wallet',
    Description: 'A folding leather wallet.',
    Category: 'Container',
    WeightGrams: 100.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 4,
    ContainerWeightGrams: 500.0,
    ContainerBlacklistedCategories: ['Weapon', 'WeaponComponent', 'Ammunition', 'Container'],
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ld_wallet_01',
  },
  purse: {
    ID: 'purse',
    DisplayName: 'Purse',
    Description: 'A shoulder purse with a clasp.',
    Category: 'Container',
    WeightGrams: 350.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 4,
    ContainerWeightGrams: 4_000.0,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ld_purse_01',
  },
  paper_bag: {
    ID: 'paper_bag',
    DisplayName: 'Brown Paper Bag',
    Description: 'A folded brown paper bag.',
    Category: 'Container',
    WeightGrams: 50.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 4,
    ContainerWeightGrams: 3_500.0,
    WorldObjectModel: 'prop_paper_bag_small',
  },
  duffel_bag: {
    ID: 'duffel_bag',
    DisplayName: 'Duffel Bag',
    Description: 'A roomy zippered duffel bag.',
    Category: 'Container',
    WeightGrams: 680.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 15,
    ContainerWeightGrams: 25_000.0,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_duffel_01',
  },
  briefcase: {
    ID: 'briefcase',
    DisplayName: 'Briefcase',
    Description: 'A hard-sided briefcase.',
    Category: 'Container',
    WeightGrams: 1_200.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 8,
    ContainerWeightGrams: 5_000.0,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_security_case_01',
  },
  suitcase: {
    ID: 'suitcase',
    DisplayName: 'Suitcase',
    Description: 'A clasped travel suitcase.',
    Category: 'Container',
    WeightGrams: 3_000.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 15,
    ContainerWeightGrams: 20_000.0,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ld_suitcase_01',
  },
  pill_bottle: {
    ID: 'pill_bottle',
    DisplayName: 'Pill Bottle',
    Description: 'A capped plastic pill bottle.',
    Category: 'Container',
    WeightGrams: 12.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 1,
    ContainerWeightGrams: 200.0,
    ContainerBlacklistedCategories: ['Weapon', 'WeaponComponent', 'Ammunition', 'Tool', 'Container'],
    WorldObjectModel: 'prop_cs_pills',
  },
  crate: {
    ID: 'crate',
    DisplayName: 'Wooden Crate',
    Description: 'A nailed wooden crate.',
    Category: 'Container',
    WeightGrams: 4_000.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsContainer: true,
    ContainerSlots: 10,
    ContainerWeightGrams: 15_000.0,
    WorldObjectModel: 'prop_box_wood01a',
  },

  // ── Narcotics. Substance items, not containers. Stack-merge purity
  // weighted-average via BlendableMetadataKeys (decision 27). Quality
  // visible; Purity / THC% / CBD% hidden. Every type carries a
  // DrugClass (feeds the addiction ledger) and a potency-scaled stat
  // boost - stimulants grant armour that drains back out, the rest
  // heal over a window. No cosmetic effects by design; narration and
  // stats are the whole high. ──
  cocaine: {
    ID: 'cocaine',
    DisplayName: 'Cocaine',
    Description: 'A small dose of white powder.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 1000,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 40,
    OnUseBoostDurationSec: 180,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_cs_coke_line',
  },
  marijuana: {
    ID: 'marijuana',
    DisplayName: 'Marijuana',
    Description: 'A bud of cannabis flower.',
    Category: 'Misc',
    WeightGrams: 0.5,
    MaxStack: 500,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Cannabis',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 10,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['StrainType'],
    BlendableMetadataKeys: ['ThcPercent', 'CbdPercent'],
    DefaultMetadata: { StrainType: 'Hybrid', ThcPercent: 20, CbdPercent: 1 },
    WorldObjectModel: 'bkr_prop_weed_bud_pruned_01a',
  },
  methamphetamine: {
    ID: 'methamphetamine',
    DisplayName: 'Methamphetamine',
    Description: 'A bag of crystalline shards.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 1000,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 50,
    OnUseBoostDurationSec: 300,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_meth_bag_01',
  },
  heroin: {
    ID: 'heroin',
    DisplayName: 'Heroin',
    Description: 'A measure of dull brown powder.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 1000,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Opioid',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 45,
    OnUseBoostDurationSec: 15,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_drug_package',
  },
  ecstasy: {
    ID: 'ecstasy',
    DisplayName: 'Ecstasy',
    Description: 'A pressed pill with a stamped logo.',
    Category: 'Misc',
    WeightGrams: 0.3,
    MaxStack: 200,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 25,
    OnUseBoostDurationSec: 240,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    DefaultMetadata: { Quality: 'Standard' },
    WorldObjectModel: 'prop_cs_pills',
  },
  oxycodone: {
    ID: 'oxycodone',
    DisplayName: 'Oxycodone',
    Description: 'A prescription bottle of opioid tablets.',
    Category: 'Misc',
    WeightGrams: 0.5,
    MaxStack: 50,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Opioid',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 30,
    OnUseBoostDurationSec: 15,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_pills',
  },
  crack: {
    ID: 'crack',
    DisplayName: 'Crack Cocaine',
    Description: 'A pale rock cooked down from cocaine.',
    Category: 'Misc',
    WeightGrams: 0.2,
    MaxStack: 500,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 50,
    OnUseBoostDurationSec: 120,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_meth_bag_01',
  },
  hashish: {
    ID: 'hashish',
    DisplayName: 'Hashish',
    Description: 'A pressed block of cannabis resin.',
    Category: 'Misc',
    WeightGrams: 1.0,
    MaxStack: 500,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Cannabis',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 20,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['ThcPercent'],
    DefaultMetadata: { Quality: 'Standard', ThcPercent: 40 },
    WorldObjectModel: 'prop_weed_block_01',
  },
  lsd: {
    ID: 'lsd',
    DisplayName: 'LSD',
    Description: 'A perforated sheet of paper tabs.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Psychedelic',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 10,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    DefaultMetadata: { Quality: 'Standard' },
    WorldObjectModel: 'xm3_prop_xm3_product_tabs_full',
  },
  mushrooms: {
    ID: 'mushrooms',
    DisplayName: 'Psilocybin Mushrooms',
    Description: 'A handful of dried mushrooms.',
    Category: 'Misc',
    WeightGrams: 1.5,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Psychedelic',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 10,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    DefaultMetadata: { Quality: 'Standard' },
    WorldObjectModel: 'ng_proc_leaves04',
  },
  ketamine: {
    ID: 'ketamine',
    DisplayName: 'Ketamine',
    Description: 'A fine white powder of veterinary provenance.',
    Category: 'Misc',
    WeightGrams: 0.2,
    MaxStack: 500,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Sedative',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 30,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_meth_bag_01',
  },
  pcp: {
    ID: 'pcp',
    DisplayName: 'PCP',
    Description: 'A potent dissociative powder.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 60,
    OnUseBoostDurationSec: 180,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_meth_bag_01',
  },
  fentanyl: {
    ID: 'fentanyl',
    DisplayName: 'Fentanyl',
    Description: 'A trace quantity of synthetic opioid powder.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Opioid',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 60,
    OnUseBoostDurationSec: 20,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_cs_pills',
  },
  opium: {
    ID: 'opium',
    DisplayName: 'Opium',
    Description: 'A sticky ball of raw poppy tar.',
    Category: 'Misc',
    WeightGrams: 1.0,
    MaxStack: 500,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Opioid',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 20,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    BlendableMetadataKeys: ['Purity'],
    DefaultMetadata: { Quality: 'Standard', Purity: 100 },
    WorldObjectModel: 'prop_drug_package',
  },
  dmt: {
    ID: 'dmt',
    DisplayName: 'DMT',
    Description: 'A crystalline psychedelic extract.',
    Category: 'Misc',
    WeightGrams: 0.1,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Psychedelic',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 10,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    VisibleMetadataKeys: ['Quality'],
    DefaultMetadata: { Quality: 'Standard' },
    WorldObjectModel: 'prop_meth_bag_01',
  },
  xanax: {
    ID: 'xanax',
    DisplayName: 'Xanax',
    Description: 'A bar-scored benzodiazepine tablet.',
    Category: 'Misc',
    WeightGrams: 0.5,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Sedative',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 20,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_pills',
  },
  adderall: {
    ID: 'adderall',
    DisplayName: 'Adderall',
    Description: 'A prescription stimulant capsule.',
    Category: 'Misc',
    WeightGrams: 0.3,
    MaxStack: 100,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 15,
    OnUseBoostDurationSec: 300,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_pills',
  },
  steroids: {
    ID: 'steroids',
    DisplayName: 'Anabolic Steroids',
    Description: 'A dosed vial of anabolic steroids.',
    Category: 'Misc',
    WeightGrams: 5.0,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Stimulant',
    OnUseBoostStat: 'AP',
    OnUseBoostAmount: 20,
    OnUseBoostDurationSec: 600,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_syringe_01',
  },
  ghb: {
    ID: 'ghb',
    DisplayName: 'GHB',
    Description: 'A small vial of clear, odorless liquid.',
    Category: 'Misc',
    WeightGrams: 2.5,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    IsDrug: true,
    DrugClass: 'Sedative',
    OnUseBoostStat: 'HP',
    OnUseBoostAmount: 20,
    OnUseBoostDurationSec: 10,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_drug_bottle',
  },

  // ── Alcoholic drinks. Each drink folds its ethanol grams (weight x
  // ABV, Shared/Constants/Alcohol.ts) into the character's stored
  // blood alcohol, which decays over time and is read back by the
  // breathalyzer. Intoxication EFFECTS (movement, camera) defer to
  // the bar slice. OnUseHpDelta is the small food-value of the drink
  // itself. ──
  beer: {
    ID: 'beer',
    DisplayName: 'Beer',
    Description: 'A bottle of beer.',
    Category: 'Consumable',
    WeightGrams: 550.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 3,
    OnUseCooldownMs: 3_000,
    AlcoholPercent: 5.0,
    LiquidVolumeMl: 500,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_beer_bottle',
  },
  whiskey: {
    ID: 'whiskey',
    DisplayName: 'Whiskey Shot',
    Description: 'A shot of whiskey.',
    Category: 'Consumable',
    WeightGrams: 140.0,
    MaxStack: 12,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 2,
    OnUseCooldownMs: 3_000,
    AlcoholPercent: 40.0,
    LiquidVolumeMl: 44,
    AllowsCustomName: true,
    WorldObjectModel: 'ba_prop_battle_shot_glass_01',
  },
  wine: {
    ID: 'wine',
    DisplayName: 'Glass of Wine',
    Description: 'A glass of red wine.',
    Category: 'Consumable',
    WeightGrams: 280.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 3,
    OnUseCooldownMs: 3_000,
    AlcoholPercent: 12.0,
    LiquidVolumeMl: 150,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_drink_redwine',
  },

  // ── Smoking. The cigarette is a zero-effect consumable - the scene
  // is the point; using one plays the generic "uses a cigarette."
  // narration and decrements the stack. ──
  cigarette: {
    ID: 'cigarette',
    DisplayName: 'Cigarette',
    Description: 'A filtered cigarette.',
    Category: 'Consumable',
    WeightGrams: 1.0,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseCooldownMs: 10_000,
    WorldObjectModel: 'prop_fag_packet_01',
  },
  lighter: {
    ID: 'lighter',
    DisplayName: 'Lighter',
    Description: 'A refillable metal lighter.',
    Category: 'Tool',
    WeightGrams: 30.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'ex_prop_exec_lighter_01',
  },

  // ── Food + soft drinks. Small HP food-values now; hunger/thirst
  // mechanics defer to a later slice the same way BAC does. ──
  water: {
    ID: 'water',
    DisplayName: 'Bottle of Water',
    Description: 'A bottle of still water.',
    Category: 'Consumable',
    WeightGrams: 510.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 2,
    OnUseCooldownMs: 3_000,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ld_flow_bottle',
  },
  ecola: {
    ID: 'ecola',
    DisplayName: 'eCola',
    Description: 'A chilled can of eCola.',
    Category: 'Consumable',
    WeightGrams: 350.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 2,
    OnUseCooldownMs: 3_000,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ecola_can',
  },
  sprunk: {
    ID: 'sprunk',
    DisplayName: 'Sprunk',
    Description: 'A cold can of Sprunk.',
    Category: 'Consumable',
    WeightGrams: 350.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 2,
    OnUseCooldownMs: 3_000,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_ld_can_01',
  },
  coffee: {
    ID: 'coffee',
    DisplayName: 'Cup of Coffee',
    Description: 'A takeaway cup of hot coffee.',
    Category: 'Consumable',
    WeightGrams: 250.0,
    MaxStack: 4,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 2,
    OnUseCooldownMs: 3_000,
    AllowsCustomName: true,
    WorldObjectModel: 'p_amb_coffeecup_01',
  },
  burger: {
    ID: 'burger',
    DisplayName: 'Burger',
    Description: 'A flame-grilled burger.',
    Category: 'Consumable',
    WeightGrams: 250.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 5,
    OnUseCooldownMs: 5_000,
    WorldObjectModel: 'prop_cs_burger_01',
  },
  donut: {
    ID: 'donut',
    DisplayName: 'Donut',
    Description: 'A glazed ring donut.',
    Category: 'Consumable',
    WeightGrams: 70.0,
    MaxStack: 6,
    IsTradeable: true,
    IsDroppable: true,
    IsConsumable: true,
    OnUseHpDelta: 3,
    OnUseCooldownMs: 3_000,
    WorldObjectModel: 'prop_amb_donut',
  },

  // ── Licenses (Phase 4). Holder-bound, permanent, non-tradeable,
  // non-droppable. Re-granted at spawn + on mid-session admin remove. ──
  license_driver: {
    ID: 'license_driver',
    DisplayName: "Driver's License",
    Description: 'State-issued driver authorization.',
    Category: 'License',
    WeightGrams: 5.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: false,
    IsDroppable: false,
    SerialDomain: 'License',
    IsHolderBound: true,
    IsPermanent: true,
    IsIdentityDocument: true,
    // Presented via /item use <slot> [player_id]; the world prop is for
    // a future hand-over surface.
    WorldObjectModel: 'p_ld_id_card_002',
  },
  license_weapon: {
    ID: 'license_weapon',
    DisplayName: 'Concealed-Carry License',
    Description: 'State-issued firearm carry authorization.',
    Category: 'License',
    WeightGrams: 5.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: false,
    IsDroppable: false,
    SerialDomain: 'License',
    IsHolderBound: true,
    IsPermanent: true,
    IsIdentityDocument: true,
    // Presented via /item use <slot> [player_id]; the world prop is for
    // a future hand-over surface.
    WorldObjectModel: 'p_ld_id_card_002',
  },

  id_card: {
    ID: 'id_card',
    DisplayName: 'State Identification Card',
    Description: 'State-issued proof of identity.',
    Category: 'License',
    WeightGrams: 5.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: false,
    IsDroppable: false,
    SerialDomain: 'License',
    IsHolderBound: true,
    IsPermanent: true,
    IsIdentityDocument: true,
    // Presented via /item use <slot> [player_id]; the world prop is for
    // a future hand-over surface.
    WorldObjectModel: 'p_ld_id_card_01',
  },

  // ── Phones. Holder rebinds on transfer (decision 13). Serial = phone
  // number, OwnerOnly visibility. Three handset tiers share identical
  // item mechanics; the future phone GUI selects its shell (modern
  // touchscreen vs push-button) off the ItemTypeID. ──
  phone_ifruit: {
    ID: 'phone_ifruit',
    DisplayName: 'iFruit Smartphone',
    Description: 'A sleek touchscreen smartphone by iFruit.',
    Category: 'Tool',
    WeightGrams: 180.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    SerialDomain: 'Phone',
    IsHolderRebindable: true,
    SerialVisibility: 'OwnerOnly',
    AllowsCustomName: true,
    WorldObjectModel: 'prop_phone_ing',
    // Seed credit balance for a freshly created handset. Flat scalar only
    // (DefaultMetadata cannot nest); NormalizePhoneMetadata in
    // Shared/Constants/Phone.ts reads PhoneCreditsCents as the starting
    // balance until the first write replaces it with the Phone blob.
    DefaultMetadata: { PhoneCreditsCents: 2500 },
  },
  phone_badger: {
    ID: 'phone_badger',
    DisplayName: 'Badger Smartphone',
    Description: 'A touchscreen smartphone by Badger.',
    Category: 'Tool',
    WeightGrams: 190.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    SerialDomain: 'Phone',
    IsHolderRebindable: true,
    SerialVisibility: 'OwnerOnly',
    AllowsCustomName: true,
    WorldObjectModel: 'prop_phone_ing_02',
    DefaultMetadata: { PhoneCreditsCents: 2500 },
  },
  phone_celltowa: {
    ID: 'phone_celltowa',
    DisplayName: 'Celltowa Phone',
    Description: 'A sturdy push-button handset by Celltowa.',
    Category: 'Tool',
    WeightGrams: 120.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    SerialDomain: 'Phone',
    IsHolderRebindable: true,
    SerialVisibility: 'OwnerOnly',
    AllowsCustomName: true,
    WorldObjectModel: 'prop_npc_phone',
    DefaultMetadata: { PhoneCreditsCents: 2500 },
  },

  // ── Handheld radio. The tuned frequencies live on the character
  // (a main channel plus additional slots, see Shared/Constants/
  // Radio.ts), so the item carries no serial - it is purely the
  // possession gate that lets a character power a radio on. Text-only
  // comms; voice is a later slice. ──
  radio: {
    ID: 'radio',
    DisplayName: 'Handheld Radio',
    Description: 'A rugged two-way radio with a stubby antenna.',
    Category: 'Tool',
    WeightGrams: 350.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_hand_radio',
  },

  // ── Paper + drop/give matrix corners (decisions 14, 35). ──
  paper: {
    ID: 'paper',
    DisplayName: 'Blank Paper',
    Description: 'Awaiting authorship.',
    Category: 'Document',
    WeightGrams: 5.0,
    MaxStack: 50,
    IsTradeable: true,
    IsDroppable: true,
    SerialDomain: 'Document',
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'p_cs_papers_01',
  },
  note: {
    ID: 'note',
    DisplayName: 'Personal Note',
    Description: 'A scribbled piece of paper.',
    Category: 'Document',
    WeightGrams: 5.0,
    MaxStack: 10,
    IsTradeable: false,
    IsDroppable: true,
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'prop_amanda_note_01',
  },

  // ── Valuables. Robbery and pawn-economy fodder; engravings arrive
  // through the custom name + description request queue. ──
  wristwatch: {
    ID: 'wristwatch',
    DisplayName: 'Wristwatch',
    Description: 'A polished analog wristwatch.',
    Category: 'Misc',
    WeightGrams: 80.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'p_watch_01',
  },
  gold_chain: {
    ID: 'gold_chain',
    DisplayName: 'Gold Chain',
    Description: 'A heavy gold neck chain.',
    Category: 'Misc',
    WeightGrams: 150.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'prop_jewel_02b',
  },
  ring: {
    ID: 'ring',
    DisplayName: 'Ring',
    Description: 'A precious-metal ring.',
    Category: 'Misc',
    WeightGrams: 10.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'prop_jewel_03a',
  },

  // ── Restraints + crime tools. Items only for now - restraint,
  // lockpicking, and narcotics-testing mechanics are later slices.
  // The lockpick has no vanilla prop; it drops as the placeholder. ──
  zipties: {
    ID: 'zipties',
    DisplayName: 'Zip Ties',
    Description: 'A bundle of heavy-duty cable ties.',
    Category: 'Tool',
    WeightGrams: 50.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'hei_prop_zip_tie_positioned',
  },
  rope: {
    ID: 'rope',
    DisplayName: 'Rope',
    Description: 'A coiled length of braided rope.',
    Category: 'Tool',
    WeightGrams: 800.0,
    MaxStack: 3,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'prop_devin_rope_01',
  },
  lockpick: {
    ID: 'lockpick',
    DisplayName: 'Lockpick',
    Description: 'A slim tension set for stubborn locks.',
    Category: 'Tool',
    WeightGrams: 30.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'm25_1_prop_m51_lockpick_01a',
  },
  scale_digital: {
    ID: 'scale_digital',
    DisplayName: 'Digital Scale',
    Description: 'A pocket scale for precise measures.',
    Category: 'Tool',
    WeightGrams: 250.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'bkr_prop_coke_scale_01',
  },
  drug_test_kit: {
    ID: 'drug_test_kit',
    DisplayName: 'Narcotics Test Kit',
    Description: 'A cased reagent kit that grades quality and purity of a sample.',
    Category: 'Tool',
    WeightGrams: 400.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    // Reusable bench kit, not a single-shot reagent: `/item use <slot>
    // <target_slot>` grades a drug without consuming the kit, gated by a
    // short cooldown so it cannot be spammed.
    IsSampleTester: true,
    OnUseCooldownMs: 5_000,
    WorldObjectModel: 'prop_ld_case_01',
  },
  handcuffs: {
    ID: 'handcuffs',
    DisplayName: 'Handcuffs',
    Description: 'A hinged pair of steel restraints.',
    Category: 'Tool',
    WeightGrams: 300.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'prop_cs_cuffs_01',
  },
  duct_tape: {
    ID: 'duct_tape',
    DisplayName: 'Duct Tape',
    Description: 'A roll of silver fabric tape.',
    Category: 'Tool',
    WeightGrams: 400.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'p_gaffer_tape_s',
  },
  boltcutters: {
    ID: 'boltcutters',
    DisplayName: 'Bolt Cutters',
    Description: 'Long-handled cutters that defeat chains and padlocks.',
    Category: 'Tool',
    WeightGrams: 2_500.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'h4_prop_h4_bolt_cutter_01a',
  },
  screwdriver: {
    ID: 'screwdriver',
    DisplayName: 'Screwdriver',
    Description: 'A flat-head screwdriver.',
    Category: 'Tool',
    WeightGrams: 150.0,
    MaxStack: 1,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'prop_tool_screwdvr01',
  },
  shovel: {
    ID: 'shovel',
    DisplayName: 'Shovel',
    Description: 'A long-handled digging shovel.',
    Category: 'Tool',
    WeightGrams: 1_500.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'prop_tool_shovel',
  },
  spraycan: {
    ID: 'spraycan',
    DisplayName: 'Spray Can',
    Description: 'A rattling can of aerosol paint.',
    Category: 'Tool',
    WeightGrams: 350.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'prop_cs_spray_can',
  },
  camera: {
    ID: 'camera',
    DisplayName: 'Camera',
    Description: 'A digital camera with a telephoto lens.',
    Category: 'Tool',
    WeightGrams: 1_200.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_pap_camera_01',
  },
  usb_drive: {
    ID: 'usb_drive',
    DisplayName: 'USB Drive',
    Description: 'A pocket flash drive of unknown contents.',
    Category: 'Tool',
    WeightGrams: 10.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    AllowsDescription: true,
    WorldObjectModel: 'sf_prop_sf_usb_drive_01a',
  },
  breathalyzer: {
    ID: 'breathalyzer',
    DisplayName: 'Breathalyzer',
    Description: 'A handheld unit that estimates blood alcohol from breath.',
    Category: 'Tool',
    WeightGrams: 300.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    IsBreathTester: true,
    WorldObjectModel: 'reh_prop_reh_rebreather_01a',
  },

  // ── Paraphernalia + leisure. Scene props; the lighter gates nothing
  // yet - smoking and gambling mechanics are later slices. ──
  rolling_papers: {
    ID: 'rolling_papers',
    DisplayName: 'Rolling Papers',
    Description: 'A booklet of thin rolling papers.',
    Category: 'Misc',
    WeightGrams: 10.0,
    MaxStack: 20,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'tr_prop_tr_note_rolled_01a',
  },
  smoking_pipe: {
    ID: 'smoking_pipe',
    DisplayName: 'Smoking Pipe',
    Description: 'A short-stemmed pipe with a charred bowl.',
    Category: 'Misc',
    WeightGrams: 150.0,
    MaxStack: 1,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_cs_meth_pipe',
  },
  bong: {
    ID: 'bong',
    DisplayName: 'Bong',
    Description: 'A tall glass water pipe.',
    Category: 'Misc',
    WeightGrams: 800.0,
    MaxStack: 1,
    IsUnique: true,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'prop_bong_01',
  },
  playing_cards: {
    ID: 'playing_cards',
    DisplayName: 'Playing Cards',
    Description: 'A worn deck of playing cards.',
    Category: 'Misc',
    WeightGrams: 80.0,
    MaxStack: 5,
    IsTradeable: true,
    IsDroppable: true,
    AllowsCustomName: true,
    WorldObjectModel: 'vw_prop_vw_casino_cards_01',
  },
  dice: {
    ID: 'dice',
    DisplayName: 'Dice',
    Description: 'A pair of six-sided dice.',
    Category: 'Misc',
    WeightGrams: 10.0,
    MaxStack: 10,
    IsTradeable: true,
    IsDroppable: true,
    WorldObjectModel: 'vw_prop_chip_10dollar_x1',
  },

  // ── World evidence. Fixtures the bleeding system anchors to the
  // ground; they never enter an inventory (pickup paths refuse
  // IsFixture) and only the age sweep removes them. BloodType is the
  // visible forensic hook for medics and detectives. ──
  blood_splat: {
    ID: 'blood_splat',
    DisplayName: 'Blood',
    Description: 'A pool of blood on the ground.',
    Category: 'Misc',
    WeightGrams: 1.0,
    MaxStack: 1,
    IsTradeable: false,
    IsDroppable: false,
    IsFixture: true,
    VisibleMetadataKeys: ['BloodType'],
    WorldObjectModel: 'p_bloodsplat_s',
    // The model is a decal plane authored upright; at the engine's
    // spawn rotation it stands on edge like a sail. Pitched -90 it
    // lies flat with the textured face up (+90 verified in-game
    // 2026-06-11: flat but face-down, transparent from above).
    WorldObjectRotation: { Pitch: -90, Roll: 0, Yaw: 0 },
  },
} as const;

/** Lookup helper; returns undefined for unknown IDs. */
export function GetItemType(ID: string): ItemTypeDefinition | undefined {
  return ItemTypes[ID];
}

/**
 * Every type declaring `IsCurrency`, in catalog order. Currency
 * behaviour code (totals, debit walks, cents formatting, ground
 * labels) keys off this set rather than the `cash` ID literal so a
 * second currency type is live the moment it lands in the catalog.
 */
export const CurrencyTypeIDs: readonly string[] = Object.values(ItemTypes)
  .filter((Type) => Type.IsCurrency === true)
  .map((Type) => Type.ID);

/** True when the type declares `IsCurrency`. */
export function IsCurrencyType(ID: string): boolean {
  return GetItemType(ID)?.IsCurrency === true;
}

/**
 * Cents represented by `Quantity` units of a currency type. Returns
 * null for non-currency types so callers cannot silently treat an
 * item count as money.
 */
export function CurrencyCents(ID: string, Quantity: number): number | null {
  const Type = GetItemType(ID);
  if (Type?.IsCurrency !== true) return null;
  return Quantity * (Type.CurrencyValuePerUnit ?? 1);
}

/**
 * Lazily-built set of every catalog weapon hash, normalised to uint32
 * (joaat hashes cross the wire sign-ambiguous). Lets the anti-cheat
 * distinguish "fired a catalog firearm" from unarmed / vehicle / fall
 * damage hashes, which are deliberately absent from the catalog.
 */
let WeaponHashIndex: Set<number> | null = null;

/**
 * Whether a weapon hash belongs to a catalog weapon.
 *
 * The index is built lazily on first call and cached, because this sits
 * on the per-discharge path where a scan over the whole catalog would be
 * paid per shot. Hashes are normalised with `>>> 0` on both sides: the
 * engine reports them as signed 32-bit in some paths and unsigned in
 * others, and an un-normalised comparison misses roughly half the
 * catalog.
 */
export function IsCatalogWeaponHash(Hash: number): boolean {
  if (WeaponHashIndex === null) {
    WeaponHashIndex = new Set<number>();
    for (const Definition of Object.values(ItemTypes)) {
      if (Definition.IsWeapon === true && Definition.WeaponHash !== undefined) {
        WeaponHashIndex.add(Definition.WeaponHash >>> 0);
      }
    }
  }
  return WeaponHashIndex.has(Hash >>> 0);
}

/**
 * Lazily-built set of every throwable catalog weapon hash (grenades,
 * sticky bombs, molotovs, etc.), normalised to uint32. A throwable
 * leaves the hand the instant it is thrown - the equipped bag is nulled
 * while the projectile is still airborne - so the anti-cheat must not
 * treat a throwable's delayed detonation as a weapon the server never
 * granted.
 */
let ThrowableHashIndex: Set<number> | null = null;

/**
 * Whether a weapon hash is a throwable (grenade, molotov).
 *
 * Same lazy-index and uint32-normalisation approach as
 * IsCatalogWeaponHash. Kept as its own index rather than a filter over
 * that one because throwables take a different discharge path - they are
 * consumed on use rather than firing rounds.
 */
export function IsThrowableWeaponHash(Hash: number): boolean {
  if (ThrowableHashIndex === null) {
    ThrowableHashIndex = new Set<number>();
    for (const Definition of Object.values(ItemTypes)) {
      if (Definition.IsWeapon === true && Definition.IsThrowable === true && Definition.WeaponHash !== undefined) {
        ThrowableHashIndex.add(Definition.WeaponHash >>> 0);
      }
    }
  }
  return ThrowableHashIndex.has(Hash >>> 0);
}

/** All catalog IDs - used by `/aitem give` validation and admin tooling. */
export function ListItemTypeIDs(): string[] {
  return Object.keys(ItemTypes);
}

/** True when the type carries a stackable cap > 1. */
export function IsStackable(Type: ItemTypeDefinition): boolean {
  return Type.MaxStack > 1 && Type.IsUnique !== true;
}
