import {
  AutoIncrement,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
  Unique,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { Character } from '@/Data/Models/Character.js';
import { Inventory } from '@/Data/Models/Inventory.js';

/**
 * One item instance. Stackable types (MaxStack > 1) merge when
 * (item_type_id + metadata_json + custom_name) match byte-for-byte;
 * non-stackables (weapons, phones, keys) always live one-per-row.
 *
 * Columns of note:
 *
 *   - `SlotIndex` is 0-based per inventory. The chat layer presents
 *     1-based labels.
 *   - `WeightGrams` is a denormalised snapshot - `WeightGrams =
 *     ItemTypeDefinition.WeightGrams * StackQuantity` for stackables,
 *     or `WeightGrams` directly for singletons. The service recomputes
 *     on every stack mutation so carry-weight sums are O(rows) without
 *     re-deriving from the type catalog.
 *   - `MetadataJson` is a free-form blob: weapon LoadedAmmo segments,
 *     drug Purity, vehicle key VehicleID, paper Description, etc.
 *     Visible-vs-hidden filtering happens in the service layer per
 *     ItemTypeDefinition.VisibleMetadataKeys.
 *   - `UniqueSerial` is the minted identifier for weapons / phones /
 *     licenses / documents / radios. Unique-indexed; nullable so
 *     non-serialed items leave it null (MySQL unique allows many NULLs).
 *     Cross-table uniqueness (vs `ground_drops.unique_serial`) is
 *     enforced by `IdentifierService.MintUnique` querying both tables.
 *   - `BoundCharacterID` is the holder for holder-bound items
 *     (licenses, phones). FK with `ON DELETE SET NULL` preserves the
 *     forensic trail past a hard delete; soft delete is invisible to
 *     the FK by design.
 *   - `ContainerInventoryID` is the inner-inventory pointer for
 *     container items (backpacks, ziplocs). Lazy-created on first
 *     AddItem; `ON DELETE SET NULL` so a deleted inner inventory
 *     does not orphan the container row.
 *   - `InvalidatedAt` is the void timestamp for keys; the lock-resolve
 *     check (vehicle slice) ignores invalidated keys without deleting.
 */
@Table({
  tableName: 'inventory_items',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class InventoryItem extends Model<
  InferAttributes<InventoryItem>,
  InferCreationAttributes<InventoryItem>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @ForeignKey(() => Inventory)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'inventory_id', allowNull: false })
  declare InventoryID: string;

  @BelongsTo(() => Inventory)
  declare Inventory?: Inventory;

  @Column({ type: DataType.TINYINT.UNSIGNED, field: 'slot_index', allowNull: false })
  declare SlotIndex: number;

  @Column({ type: DataType.STRING(64), field: 'item_type_id', allowNull: false })
  declare ItemTypeID: string;

  @Column({ type: DataType.INTEGER.UNSIGNED, field: 'stack_quantity', allowNull: true })
  declare StackQuantity: CreationOptional<number | null>;

  @Column({ type: DataType.DECIMAL(8, 2), field: 'weight_grams', allowNull: false })
  declare WeightGrams: string;

  @Column({ type: DataType.TEXT, field: 'metadata_json', allowNull: true })
  declare MetadataJson: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), field: 'custom_name', allowNull: true })
  declare CustomName: CreationOptional<string | null>;

  @Unique
  @Column({ type: DataType.STRING(32), field: 'unique_serial', allowNull: true })
  declare UniqueSerial: CreationOptional<string | null>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'bound_character_id', allowNull: true })
  declare BoundCharacterID: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, field: 'invalidated_at', allowNull: true })
  declare InvalidatedAt: CreationOptional<Date | null>;

  @ForeignKey(() => Inventory)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'container_inventory_id', allowNull: true })
  declare ContainerInventoryID: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
