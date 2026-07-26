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
 * Create the `ground_drops` table.
 *
 * Drops sit in a separate table because they carry no slot grid -
 * every drop is one instance anchored to its world coord. Identity
 * (item type, metadata, custom name, serial, holder bind, inner
 * inventory pointer for containers) is preserved verbatim through
 * the drop / pickup round-trip.
 *
 *   - `dropped_at` doubles as a race-safe pickup fingerprint -
 *     `DELETE ... WHERE id = ? AND dropped_at = ?` lets one of N
 *     racing pickers win the affected-rows.
 *   - `unique_serial` is unique-indexed for `IdentifierService`'s
 *     cross-table collision check.
 *   - Spatial index `(world, position_x, position_y)` powers
 *     `/nearitems` and the spawn-on-client gating.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('ground_drops', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    item_type_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    stack_quantity: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    weight_grams: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: false,
    },
    metadata_json: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    custom_name: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    unique_serial: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    bound_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    dropped_by_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    container_inventory_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'inventories', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    world: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    position_x: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
    },
    position_y: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
    },
    position_z: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
    },
    dropped_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
  });

  await Sequelize.query(
    'ALTER TABLE ground_drops MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  await Qi.addIndex('ground_drops', ['unique_serial'], {
    name: 'uq_ground_drops_unique_serial',
    unique: true,
  });
  await Qi.addIndex('ground_drops', ['world', 'position_x', 'position_y'], {
    name: 'idx_ground_drops_spatial',
  });
  await Qi.addIndex('ground_drops', ['dropped_by_character_id'], {
    name: 'idx_ground_drops_dropper',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('ground_drops');
}
