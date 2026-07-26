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
 * Create the `item_name_requests` table.
 *
 * Unified queue for both custom name and free-form description
 * submissions awaiting staff review (decisions 14, 44). The `kind`
 * discriminator routes the approval write:
 *
 *   - kind='Name'         -> writes to inventory_items.custom_name
 *   - kind='Description'  -> writes to metadata_json.Description
 *
 * `(inventory_item_id, kind)` is unique so a re-submission of the
 * same kind replaces the prior pending row.
 *
 * Length cap 512 chars covers both 2-64 char names and 2-512 char
 * descriptions; the per-kind length check happens in the service.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('item_name_requests', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    inventory_item_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'inventory_items', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    kind: {
      type: DataTypes.ENUM('Name', 'Description'),
      allowNull: false,
    },
    requested_text: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    requested_by_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    requested_at: {
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
    'ALTER TABLE item_name_requests MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  await Qi.addIndex('item_name_requests', ['inventory_item_id', 'kind'], {
    name: 'uq_item_name_requests_item_kind',
    unique: true,
  });
  await Qi.addIndex('item_name_requests', ['requested_by_character_id'], {
    name: 'idx_item_name_requests_character',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('item_name_requests');
}
