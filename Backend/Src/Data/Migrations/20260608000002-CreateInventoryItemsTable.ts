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
 * Create the `inventory_items` table.
 *
 *   - PK `id` BIGINT UNSIGNED auto-increment.
 *   - FK `inventory_id` -> inventories.id ON DELETE CASCADE.
 *   - `(inventory_id, slot_index)` UNIQUE - one item per slot.
 *   - `unique_serial` UNIQUE (nullable - many NULLs allowed) - weapon
 *     serial / phone number / license number / document number /
 *     radio frequency. Cross-table uniqueness vs `ground_drops`
 *     enforced by `IdentifierService.MintUnique`.
 *   - FK `bound_character_id` -> characters.id ON DELETE SET NULL -
 *     forensic trail outlives the holder's row.
 *   - FK `container_inventory_id` -> inventories.id ON DELETE SET NULL -
 *     a container item's inner inventory; lazy-created on first
 *     AddItem.
 *   - `weight_grams` is denormalised (WeightGrams * StackQuantity for
 *     stackables, WeightGrams for singletons) so carry-weight sums
 *     stay O(rows) without re-deriving from the type catalog.
 *   - `metadata_json` is a free-form blob - weapon LoadedAmmo segments,
 *     drug Purity, key VehicleID, paper Description. Visible vs hidden
 *     filtering happens in the service layer per ItemTypeDefinition
 *     VisibleMetadataKeys.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('inventory_items', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    inventory_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'inventories', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    slot_index: {
      type: DataTypes.TINYINT.UNSIGNED,
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
    invalidated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    container_inventory_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'inventories', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
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
    'ALTER TABLE inventory_items MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  await Qi.addIndex('inventory_items', ['inventory_id', 'slot_index'], {
    name: 'uq_inventory_items_slot',
    unique: true,
  });
  await Qi.addIndex('inventory_items', ['unique_serial'], {
    name: 'uq_inventory_items_unique_serial',
    unique: true,
  });
  await Qi.addIndex('inventory_items', ['bound_character_id'], {
    name: 'idx_inventory_items_bound_character_id',
  });
  await Qi.addIndex('inventory_items', ['item_type_id'], {
    name: 'idx_inventory_items_item_type_id',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('inventory_items');
}
