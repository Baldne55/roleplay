import { DataTypes, literal, type QueryInterface, type Sequelize } from 'sequelize';

/**
 * Umzug migration context. Carries the Sequelize instance whose
 * QueryInterface performs the schema change - migrations never touch the
 * application connection, which is not yet built when they run.
 */
interface Context {
  Sequelize: Sequelize;
}

/**
 * Create the `inventory_mutation_log` table.
 *
 * Append-only forensic trail. One row per mutation
 * (Add/Remove/Move/Transfer/Drop/Pickup/Attach/Detach/Deface/Rebind/
 * Rename/AdminGive/AdminRemove/AdminMint/Reload/WeaponShot/
 * WeaponDischarge). The append happens inside the same Sequelize
 * transaction as the mutation itself; either both commit or both roll
 * back. There is no fire-and-forget path.
 *
 * Multi-row mutations (Transfer = Remove + Add; container drop =
 * Remove + GroundCreate; weapon attach = Remove + WeaponEdit) share a
 * single `transaction_id` UUID so `/aitemtrace` can re-assemble the
 * atomic group across rows.
 *
 * No FK on from / to inventory IDs - rows survive the deletion of
 * their source inventories (forensic trail must outlive the items).
 *
 * No `updated_at` - rows are append-only facts, never re-stated.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('inventory_mutation_log', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    action: {
      type: DataTypes.ENUM(
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
      allowNull: false,
    },
    transaction_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
    },
    actor_source: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    actor_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    actor_account_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    item_type_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    unique_serial: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    from_inventory_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    from_slot_index: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: true,
    },
    to_inventory_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    to_slot_index: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: true,
    },
    reason: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
  });

  await Qi.addIndex('inventory_mutation_log', ['unique_serial'], {
    name: 'idx_mutation_log_unique_serial',
  });
  await Qi.addIndex('inventory_mutation_log', ['transaction_id'], {
    name: 'idx_mutation_log_transaction_id',
  });
  await Qi.addIndex('inventory_mutation_log', ['actor_character_id'], {
    name: 'idx_mutation_log_actor_character_id',
  });
  await Qi.addIndex('inventory_mutation_log', ['item_type_id'], {
    name: 'idx_mutation_log_item_type_id',
  });
  await Qi.addIndex('inventory_mutation_log', ['created_at'], {
    name: 'idx_mutation_log_created_at',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('inventory_mutation_log');
}
