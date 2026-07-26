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
 * One item lying on the ground. Separate from `inventory_items` because
 * the row carries no slot grid - every drop is a single instance
 * anchored to its world coord. Identity (item_type_id, metadata,
 * custom_name, unique_serial, bound_character_id, inner inventory) is
 * preserved verbatim through the drop / pickup round-trip.
 *
 * `container_inventory_id` keeps the nested inner inventory of a
 * dropped container alive across the ground round-trip - the inner
 * rows stay in `inventory_items` pointing at that inventory while the
 * container itself sits on the ground, and pickup re-stitches the
 * reference to the new container row.
 *
 * `dropped_at` doubles as a fingerprint for the
 * `DELETE ... WHERE id = ? AND dropped_at = ?` race-safe pickup path
 * (decision 7 B1 fix) - one of N racing pickers wins the affected-row.
 *
 * No FK on `container_inventory_id` cascading - the inner inventory
 * is shared with whoever picks up the container. `ON DELETE SET NULL`
 * leaves the orphaned ground row recoverable.
 */
@Table({
  tableName: 'ground_drops',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class GroundDrop extends Model<
  InferAttributes<GroundDrop>,
  InferCreationAttributes<GroundDrop>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

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

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'dropped_by_character_id', allowNull: true })
  declare DroppedByCharacterID: CreationOptional<string | null>;

  @BelongsTo(() => Character, 'DroppedByCharacterID')
  declare DroppedBy?: Character;

  @ForeignKey(() => Inventory)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'container_inventory_id', allowNull: true })
  declare ContainerInventoryID: CreationOptional<string | null>;

  @Column({ type: DataType.INTEGER, field: 'world', allowNull: false })
  declare World: number;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_x', allowNull: false })
  declare PositionX: string;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_y', allowNull: false })
  declare PositionY: string;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_z', allowNull: false })
  declare PositionZ: string;

  @Column({ type: DataType.DATE, field: 'dropped_at', allowNull: false })
  declare DroppedAt: Date;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
