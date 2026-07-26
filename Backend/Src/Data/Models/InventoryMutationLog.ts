import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import type { InventoryMutationAction } from '@Shared/Constants/Inventory.js';

/**
 * Append-only forensic trail. One row per inventory mutation -
 * Add/Remove/Move/Transfer/Drop/Pickup/Attach/Detach/Deface/Rebind/
 * Rename/AdminGive/AdminRemove/AdminMint/Reload/WeaponShot/WeaponDischarge.
 *
 * The row is appended **inside** the same Sequelize transaction as the
 * mutation itself - failure of either rolls back both. There is no
 * fire-and-forget path; forensic completeness is a hard guarantee.
 *
 * Multi-row mutations (Transfer = Remove + Add, container drop =
 * Remove + GroundCreate, weapon attach = Remove + WeaponEdit) share a
 * single `transaction_id` UUID so `/aitemtrace` can re-assemble the
 * atomic group from disparate rows.
 *
 * System actions (Inventory.ApplyOnSpawn re-grant, future cron sweeps)
 * leave `actor_source / actor_character_id / actor_account_id` null and
 * populate `reason`; the `/aiteminspect` renderer labels these as
 * `[system]` so the null actor is explicit, not a gap.
 *
 * No FK enforcement on inventory IDs - rows survive their source
 * inventories' deletion (forensic trail must persist past the items
 * themselves).
 */
@Table({
  tableName: 'inventory_mutation_log',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: false,
  underscored: false,
})
export class InventoryMutationLog extends Model<
  InferAttributes<InventoryMutationLog>,
  InferCreationAttributes<InventoryMutationLog>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @Column({
    type: DataType.ENUM(
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
    ),
    field: 'action',
    allowNull: false,
  })
  declare Action: InventoryMutationAction;

  @Column({ type: DataType.STRING(36), field: 'transaction_id', allowNull: false })
  declare TransactionID: string;

  @Column({ type: DataType.INTEGER, field: 'actor_source', allowNull: true })
  declare ActorSource: CreationOptional<number | null>;

  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'actor_character_id', allowNull: true })
  declare ActorCharacterID: CreationOptional<string | null>;

  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'actor_account_id', allowNull: true })
  declare ActorAccountID: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), field: 'item_type_id', allowNull: false })
  declare ItemTypeID: string;

  @Column({ type: DataType.INTEGER.UNSIGNED, field: 'quantity', allowNull: true })
  declare Quantity: CreationOptional<number | null>;

  @Column({ type: DataType.STRING(32), field: 'unique_serial', allowNull: true })
  declare UniqueSerial: CreationOptional<string | null>;

  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'from_inventory_id', allowNull: true })
  declare FromInventoryID: CreationOptional<string | null>;

  @Column({ type: DataType.TINYINT.UNSIGNED, field: 'from_slot_index', allowNull: true })
  declare FromSlotIndex: CreationOptional<number | null>;

  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'to_inventory_id', allowNull: true })
  declare ToInventoryID: CreationOptional<string | null>;

  @Column({ type: DataType.TINYINT.UNSIGNED, field: 'to_slot_index', allowNull: true })
  declare ToSlotIndex: CreationOptional<number | null>;

  @Column({ type: DataType.STRING(128), field: 'reason', allowNull: true })
  declare Reason: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;
}
