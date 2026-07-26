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
 * Create the `inventories` table.
 *
 *   - PK `id` BIGINT UNSIGNED auto-increment.
 *   - `(owner_type, owner_id)` UNIQUE - one inventory per owner.
 *   - Polymorphic owner enum: Character + Container are operational in
 *     Phase 1; VehicleTrunk / VehicleGlovebox / Property / Business are
 *     reserved and the service rejects them with `OwnerTypeNotSupported`
 *     until those slices land.
 *   - `slot_capacity` defaults to 20 (DefaultCharacterSlotCapacity);
 *     `weight_capacity_grams` defaults to 20,000.00g
 *     (DefaultCharacterWeightCapacityGrams). Both can be raised
 *     mid-session via `/aextendinventory`.
 *   - No FK on owner_id (polymorphic). Soft-delete of a character does
 *     NOT cascade - the forensic trail and the recovered-character
 *     restore path depend on the inventory surviving the status flip.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('inventories', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    owner_type: {
      type: DataTypes.ENUM(
        'Character',
        'Container',
        'VehicleTrunk',
        'VehicleGlovebox',
        'Property',
        'Business',
      ),
      allowNull: false,
    },
    owner_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    slot_capacity: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 20,
    },
    weight_capacity_grams: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: '20000.00',
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
    'ALTER TABLE inventories MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  await Qi.addIndex('inventories', ['owner_type', 'owner_id'], {
    name: 'uq_inventories_owner',
    unique: true,
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('inventories');
}
