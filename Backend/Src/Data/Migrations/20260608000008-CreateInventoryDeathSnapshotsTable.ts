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
 * Create the `inventory_death_snapshots` table.
 *
 * Forward-compat declaration (decision 41). Populated by the future
 * death-drop slice on every transition to `Dead`; v1 does not write
 * rows. Declared now so the schema is forward-compatible.
 *
 *   payload_json: server-composed JSON of (slot_index, item_type_id,
 *   stack_quantity, metadata_json, custom_name, unique_serial,
 *   weight_grams) per item carried at time of death.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('inventory_death_snapshots', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    snapshot_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    payload_json: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
  });

  await Qi.addIndex('inventory_death_snapshots', ['character_id', 'snapshot_at'], {
    name: 'idx_inventory_death_snapshots_character_at',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('inventory_death_snapshots');
}
