import { Op, type Transaction } from 'sequelize';
import {
  DefaultCharacterSlotCapacity,
  DefaultCharacterWeightCapacityGrams,
  type OwnerType,
} from '@Shared/Constants/Inventory.js';
import { CurrencyCents, CurrencyTypeIDs } from '@Shared/Constants/ItemTypes.js';
import { Inventory } from '@/Data/Models/Inventory.js';
import { InventoryItem } from '@/Data/Models/InventoryItem.js';

/**
 * Column values for a new inventory_items row.
 *
 * `WeightGrams` is a string because the column is DECIMAL and mysql2
 * round-trips DECIMAL as string - carrying it as a JS number would lose
 * precision on large stacks. Same reasoning as the runtime's Bank field.
 */
export interface CreateItemFields {
  InventoryID: string;
  SlotIndex: number;
  ItemTypeID: string;
  StackQuantity: number | null;
  WeightGrams: string;
  MetadataJson?: string | null;
  CustomName?: string | null;
  UniqueSerial?: string | null;
  BoundCharacterID?: string | null;
  ContainerInventoryID?: string | null;
}

/**
 * Mutable columns on an existing item row. Passed as a partial - only the
 * named fields are written, so a caller re-stamping a serial does not
 * have to restate the stack quantity it is not changing.
 */
export interface SaveItemFields {
  SlotIndex: number;
  StackQuantity: number | null;
  WeightGrams: string;
  CustomName: string | null;
  BoundCharacterID: string | null;
  InvalidatedAt: Date | null;
  ContainerInventoryID: string | null;
}

/**
 * Inventory + InventoryItem data access. SQL-thin wrapper; the
 * business rules (slot allocation, stack merge, weight cap, async
 * lock) live in InventoryService.
 *
 * Metadata writes split into two methods to avoid clobber:
 *   - `SetMetadata(ID, FullObject)` replaces the entire metadata blob.
 *   - `MergeMetadata(ID, Patch)` reads, deep-merges, writes back inside
 *     the caller's lock window. Use this for incremental updates
 *     (LoadedAmmo after a shot, Quality decay, AttachedComponents
 *     after attach) so sibling keys are preserved.
 *
 * Every mutation accepts an optional Sequelize `Transaction` so the
 * caller can bundle the mutation with its audit-log row (decision 34)
 * in one atomic unit.
 */
export class InventoryRepository {
  /**
   * Get-or-create the character's inventory. Idempotent: the first
   * spawn after creation inserts the row, subsequent spawns just read.
   */
  async GetOrCreateForCharacter(CharacterID: string): Promise<Inventory> {
    const [Row] = await Inventory.findOrCreate({
      where: { OwnerType: 'Character' as OwnerType, OwnerID: CharacterID },
      defaults: {
        OwnerType: 'Character',
        OwnerID: CharacterID,
        SlotCapacity: DefaultCharacterSlotCapacity,
        WeightCapacityGrams: DefaultCharacterWeightCapacityGrams.toFixed(2),
      },
    });
    return Row;
  }

  /**
   * Inventory by owner. Hits the unique `(owner_type, owner_id)` index,
   * so a character has at most one carried inventory. Returns null rather
   * than creating - see GetOrCreateForCharacter for the creating variant.
   */
  GetByOwner(OwnerType: OwnerType, OwnerID: string): Promise<Inventory | null> {
    return Inventory.findOne({ where: { OwnerType, OwnerID } });
  }

  /** Inventory by id - used for container inners, which have no owner row. */
  FindByID(ID: string): Promise<Inventory | null> {
    return Inventory.findByPk(ID);
  }

  /**
   * Every item in an inventory, ordered by slot.
   *
   * The workhorse read. Rides the leftmost prefix of the unique
   * `(inventory_id, slot_index)` index, so it is an index scan rather
   * than a table scan.
   */
  LoadItems(InventoryID: string): Promise<InventoryItem[]> {
    return InventoryItem.findAll({
      where: { InventoryID },
      order: [['SlotIndex', 'ASC']],
    });
  }

  /** A single item row by primary key. */
  FindItemByID(ID: string): Promise<InventoryItem | null> {
    return InventoryItem.findByPk(ID);
  }

  /**
   * Insert an item row.
   *
   * Transaction-aware so composite operations (transfer, pickup,
   * container moves) can bundle the add with its matching remove and
   * commit them as one unit.
   */
  async CreateItem(Fields: CreateItemFields, T?: Transaction): Promise<InventoryItem> {
    const Payload = {
      InventoryID: Fields.InventoryID,
      SlotIndex: Fields.SlotIndex,
      ItemTypeID: Fields.ItemTypeID,
      StackQuantity: Fields.StackQuantity,
      WeightGrams: Fields.WeightGrams,
      MetadataJson: Fields.MetadataJson ?? null,
      CustomName: Fields.CustomName ?? null,
      UniqueSerial: Fields.UniqueSerial ?? null,
      BoundCharacterID: Fields.BoundCharacterID ?? null,
      ContainerInventoryID: Fields.ContainerInventoryID ?? null,
    };
    return await InventoryItem.create(
      Payload,
      T !== undefined ? { transaction: T } : undefined,
    );
  }

  /**
   * Update a subset of the persisted item fields with a single targeted
   * UPDATE. Mirrors `CharacterRepository.SaveRuntime` / `SaveInjury` -
   * the typed Fields object lists exactly what the caller intends to
   * write; missing keys leave the column untouched.
   *
   * Metadata is NOT writable via this method - use SetMetadata /
   * MergeMetadata so the read-modify-write semantics are explicit.
   */
  async SaveItem(
    ID: string,
    Fields: Partial<SaveItemFields>,
    T?: Transaction,
  ): Promise<void> {
    const Update: Record<string, unknown> = {};
    if (Fields.SlotIndex !== undefined) Update.SlotIndex = Fields.SlotIndex;
    if (Fields.StackQuantity !== undefined) Update.StackQuantity = Fields.StackQuantity;
    if (Fields.WeightGrams !== undefined) Update.WeightGrams = Fields.WeightGrams;
    if (Fields.CustomName !== undefined) Update.CustomName = Fields.CustomName;
    if (Fields.BoundCharacterID !== undefined) Update.BoundCharacterID = Fields.BoundCharacterID;
    if (Fields.InvalidatedAt !== undefined) Update.InvalidatedAt = Fields.InvalidatedAt;
    if (Fields.ContainerInventoryID !== undefined) {
      Update.ContainerInventoryID = Fields.ContainerInventoryID;
    }
    if (Object.keys(Update).length === 0) return;
    await InventoryItem.update(Update, {
      where: { ID },
      ...(T !== undefined ? { transaction: T } : {}),
    });
  }

  /** Replace the entire metadata blob. Used at creation + full rewrites. */
  async SetMetadata(
    ID: string,
    Full: Record<string, unknown>,
    T?: Transaction,
  ): Promise<void> {
    await InventoryItem.update(
      { MetadataJson: JSON.stringify(Full) },
      {
        where: { ID },
        ...(T !== undefined ? { transaction: T } : {}),
      },
    );
  }

  /**
   * Read-modify-write deep-merge of `Patch` into the row's existing
   * metadata. Must be called inside the caller's lock window (decision
   * 8) - the load + merge + write is not atomic against the DB.
   *
   * Patch keys with value `null` DELETE the corresponding key from the
   * merged blob; non-null values replace.
   *
   * `KnownJson` lets a caller that ALREADY holds the row's metadata
   * (the weapon-discharge and reload paths both loaded it a few lines
   * earlier) skip the read half, turning the hottest write in the
   * system from SELECT + UPDATE into a single UPDATE. Only safe from
   * inside the caller's lock window, which is where the read-modify-
   * write is required to happen anyway. Pass `undefined` - not null -
   * to force the read; null is a legitimate "row has no metadata".
   */
  async MergeMetadata(
    ID: string,
    Patch: Record<string, unknown>,
    T?: Transaction,
    KnownJson?: string | null,
  ): Promise<void> {
    let SourceJson: string | null;
    if (KnownJson !== undefined) {
      SourceJson = KnownJson;
    } else {
      const Row = await InventoryItem.findByPk(ID, {
        ...(T !== undefined ? { transaction: T } : {}),
      });
      if (Row === null) return;
      SourceJson = Row.MetadataJson;
    }
    const Current: Record<string, unknown> =
      SourceJson === null ? {} : (JSON.parse(SourceJson) as Record<string, unknown>);
    for (const [Key, Value] of Object.entries(Patch)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- patch semantics: a null value deletes the key from the JSON blob
      if (Value === null) delete Current[Key];
      else Current[Key] = Value;
    }
    await InventoryItem.update(
      { MetadataJson: JSON.stringify(Current) },
      {
        where: { ID },
        ...(T !== undefined ? { transaction: T } : {}),
      },
    );
  }

  /**
   * Hard-delete an item row.
   *
   * Genuinely destructive, unlike the character soft delete - an item
   * that leaves the world leaves no row. The audit trail is what
   * preserves its history, which is why the mutation log is written in
   * the same transaction rather than derived from surviving rows.
   */
  async DeleteItem(ID: string, T?: Transaction): Promise<void> {
    await InventoryItem.destroy({
      where: { ID },
      ...(T !== undefined ? { transaction: T } : {}),
    });
  }

  /**
   * Resize an inventory's ceilings, both axes at once.
   *
   * Shrinking below current contents is permitted and drops nothing - the
   * inventory simply sits over capacity until the player removes
   * something. Silently destroying the excess would be far worse than a
   * temporarily illegal state.
   */
  async SaveCapacity(
    InventoryID: string,
    SlotCapacity: number,
    WeightCapacityGrams: number,
  ): Promise<void> {
    await Inventory.update(
      {
        SlotCapacity,
        WeightCapacityGrams: WeightCapacityGrams.toFixed(2),
      },
      { where: { ID: InventoryID } },
    );
  }

  /**
   * Locate a serialised item anywhere in storage - backs `/aitem find`.
   *
   * Unique-indexed, and works regardless of who holds it or whether they
   * are online, which is the point: a stolen weapon is rarely still with
   * the person who took it.
   */
  FindByUniqueSerial(Serial: string): Promise<InventoryItem | null> {
    return InventoryItem.findOne({ where: { UniqueSerial: Serial } });
  }

  /**
   * Every holder-bound item belonging to a character, oldest first.
   *
   * Bound items (phones, radios, licences) carry an owning character
   * independent of which inventory physically holds them - so this finds
   * a player's phone even while someone else is carrying it.
   */
  FindByBoundCharacter(CharacterID: string): Promise<InventoryItem[]> {
    return InventoryItem.findAll({
      where: { BoundCharacterID: CharacterID },
      order: [['CreatedAt', 'ASC']],
    });
  }

  /**
   * Aggregate every currency row in the character's inventory into
   * cents, valuing each type at its catalog CurrencyValuePerUnit. Sum
   * is BIGINT-safe via SQL but we coerce through Number; cash carry
   * tops out at ~$2M ($200M cents) which is well inside Number's safe
   * integer range. The bank slice will handle large balances.
   */
  async CountCurrencyCentsForCharacter(CharacterID: string): Promise<number> {
    const Inventory = await this.GetByOwner('Character', CharacterID);
    if (Inventory === null) return 0;
    const Rows = await InventoryItem.findAll({
      where: { InventoryID: Inventory.ID, ItemTypeID: CurrencyTypeIDs as string[] },
      attributes: ['ItemTypeID', 'StackQuantity'],
    });
    let Total = 0;
    for (const Row of Rows) {
      if (Row.StackQuantity === null) continue;
      Total += CurrencyCents(Row.ItemTypeID, Row.StackQuantity) ?? 0;
    }
    return Total;
  }

  /**
   * Existing items in `InventoryID` matching the type + custom_name
   * filter, ordered by slot. Non-blendable byte-for-byte match
   * filtering happens in the caller (InventoryService.PerformAdd) so
   * blendable-metadata stacks can join rows even when their numeric
   * percentages differ (decision 27).
   */
  async FindStackableMatches(
    InventoryID: string,
    ItemTypeID: string,
    CustomName: string | null,
    T?: Transaction,
  ): Promise<InventoryItem[]> {
    return await InventoryItem.findAll({
      where: {
        InventoryID,
        ItemTypeID,
        CustomName,
      },
      order: [['SlotIndex', 'ASC']],
      ...(T !== undefined ? { transaction: T } : {}),
    });
  }

  /**
   * Every occupied slot index in the inventory, as a set. Callers that
   * allocate ONE slot want NextFreeSlot; callers that allocate several
   * in a row (PerformAdd spilling a large stack) take this once and
   * walk it in memory - re-querying per slot re-scanned the whole
   * inventory for each unit of spill.
   */
  async TakenSlots(InventoryID: string, T?: Transaction): Promise<Set<number>> {
    const Rows = await InventoryItem.findAll({
      where: { InventoryID },
      attributes: ['SlotIndex'],
      ...(T !== undefined ? { transaction: T } : {}),
    });
    return new Set(Rows.map((R) => R.SlotIndex));
  }

  /**
   * Lowest unused slot index in [0, SlotCapacity). Returns null when
   * the inventory is full. Called inside the AddItem / MoveItem lock
   * window so a concurrent insert cannot race-overwrite the chosen
   * slot.
   */
  async NextFreeSlot(
    InventoryID: string,
    SlotCapacity: number,
    T?: Transaction,
  ): Promise<number | null> {
    const Taken = await this.TakenSlots(InventoryID, T);
    return FirstFreeSlot(Taken, SlotCapacity);
  }

  /**
   * Sum of `weight_grams` across every row in the inventory. Used by
   * the carry-weight check on AddItem - twice per add when the target
   * is a container, so it aggregates in SQL rather than shipping every
   * row's weight back to sum in JS. Rounds to two decimals to dodge
   * IEEE-754 drift, matching the DECIMAL(8,2) column.
   */
  async CarryWeightGrams(InventoryID: string, T?: Transaction): Promise<number> {
    const Total = await InventoryItem.sum('WeightGrams', {
      where: { InventoryID },
      ...(T !== undefined ? { transaction: T } : {}),
    });
    // sum() yields null for an empty inventory and may hand back a
    // DECIMAL string depending on the dialect's type parser.
    const Numeric = typeof Total === 'number' ? Total : Number.parseFloat(String(Total ?? 0));
    if (!Number.isFinite(Numeric)) return 0;
    return Math.round(Numeric * 100) / 100;
  }

  /**
   * Presence test for one item type, as an indexed single-row probe.
   * The callers that need this (the radio possession gate and its
   * sweep) want a boolean, not an inventory - loading every row with
   * its metadata blob to run `.some()` over it was orders of magnitude
   * more work than the question deserved.
   */
  async HasItemType(InventoryID: string, ItemTypeID: string): Promise<boolean> {
    const Row = await InventoryItem.findOne({
      where: { InventoryID, ItemTypeID },
      attributes: ['ID'],
    });
    return Row !== null;
  }

  /**
   * Lean projection for the phone-serial walk: the three columns the
   * traversal actually reads, instead of full rows carrying every
   * item's metadata JSON.
   */
  async LoadItemsForSerialWalk(
    InventoryID: string,
  ): Promise<{ ItemTypeID: string; UniqueSerial: string | null; ContainerInventoryID: string | null }[]> {
    const Rows = await InventoryItem.findAll({
      where: { InventoryID },
      attributes: ['ItemTypeID', 'UniqueSerial', 'ContainerInventoryID'],
      order: [['SlotIndex', 'ASC']],
    });
    return Rows.map((R) => ({
      ItemTypeID: R.ItemTypeID,
      UniqueSerial: R.UniqueSerial,
      ContainerInventoryID: R.ContainerInventoryID,
    }));
  }

  /**
   * Permanent-item presence query for `Inventory.ApplyOnSpawn` -
   * batched single query rather than one-call-per-type (decision 39).
   */
  async HeldPermanentTypeIDs(
    InventoryID: string,
    TypeIDs: readonly string[],
  ): Promise<Set<string>> {
    if (TypeIDs.length === 0) return new Set();
    const Rows = await InventoryItem.findAll({
      where: {
        InventoryID,
        ItemTypeID: { [Op.in]: [...TypeIDs] },
      },
      attributes: ['ItemTypeID'],
    });
    return new Set(Rows.map((R) => R.ItemTypeID));
  }
}

/**
 * Lowest index in [0, SlotCapacity) not present in `Taken`, or null when
 * every slot is occupied. Shared by the single-slot query and the
 * in-memory allocation walk so both agree on "lowest free wins".
 */
export function FirstFreeSlot(Taken: ReadonlySet<number>, SlotCapacity: number): number | null {
  for (let I = 0; I < SlotCapacity; I += 1) {
    if (!Taken.has(I)) return I;
  }
  return null;
}
