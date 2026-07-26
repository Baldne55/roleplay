import {
  AutoIncrement,
  Column,
  DataType,
  Default,
  HasMany,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import type { OwnerType } from '@Shared/Constants/Inventory.js';
import { InventoryItem } from '@/Data/Models/InventoryItem.js';

/**
 * One storage surface in the world: a character's pockets, a backpack's
 * inner inventory, a future vehicle trunk / property safe / business
 * stash. Discriminated by `OwnerType` (which determines what `OwnerID`
 * references) so a single table covers every surface.
 *
 *   - `OwnerType='Character', OwnerID=<character_id>`  - the player's main inventory.
 *   - `OwnerType='Container', OwnerID=<inventory_item_id>` - a container item's
 *     inner inventory, lazy-created on first AddItem.
 *   - The other owner types are reserved for later slices; the service
 *     layer rejects them with `OwnerTypeNotSupported`.
 *
 * `(OwnerType, OwnerID)` is uniquely indexed - one inventory per owner.
 *
 * `SlotCapacity` is the grid cell count (default 20 for Character).
 * `WeightCapacityGrams` is the carry-weight cap (default 20,000.00g for
 * Character) - persisted decimal grams matching the inventory_items'
 * weight_grams column for symmetric arithmetic. Both can be raised
 * mid-session via `/aextendinventory`.
 *
 * No FK on OwnerID (polymorphic). Soft-delete of the owner does NOT
 * cascade - inventory survives a `Character.Status='Deleted'` flip so
 * a recovered character keeps their pockets.
 *
 * Column mappings: every column carries an explicit `field:` so
 * PascalCase TS names map to snake_case DB columns without lodash
 * mangling acronyms.
 */
@Table({
  tableName: 'inventories',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class Inventory extends Model<
  InferAttributes<Inventory>,
  InferCreationAttributes<Inventory>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @Column({
    type: DataType.ENUM(
      'Character',
      'Container',
      'VehicleTrunk',
      'VehicleGlovebox',
      'Property',
      'Business',
    ),
    field: 'owner_type',
    allowNull: false,
  })
  declare OwnerType: OwnerType;

  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'owner_id', allowNull: false })
  declare OwnerID: string;

  @Default(20)
  @Column({ type: DataType.TINYINT.UNSIGNED, field: 'slot_capacity', allowNull: false })
  declare SlotCapacity: CreationOptional<number>;

  @Default('20000.00')
  @Column({ type: DataType.DECIMAL(10, 2), field: 'weight_capacity_grams', allowNull: false })
  declare WeightCapacityGrams: CreationOptional<string>;

  @HasMany(() => InventoryItem)
  declare Items?: InventoryItem[];

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
