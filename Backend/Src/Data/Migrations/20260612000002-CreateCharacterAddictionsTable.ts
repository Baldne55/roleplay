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
 * Create the `character_addictions` table.
 *
 * One row per (character, drug class) pair, carrying the addiction
 * level as of `last_dose_at`. Like the blood-alcohol columns, the
 * decay is computed lazily from the stamp on every read
 * (Shared/Constants/Drugs.ts) - no recurring job writes these rows;
 * dosing is the only writer. The class is the Shared DrugClass union
 * as a string ('Stimulant', 'Opioid', 'Cannabis', 'Psychedelic',
 * 'Sedative', 'Alcohol') rather than an ENUM so future classes land
 * without a schema change.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('character_addictions', {
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
    drug_class: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    level: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: '0.00',
    },
    last_dose_at: {
      type: DataTypes.DATE,
      allowNull: true,
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

  await Qi.sequelize.query(
    'ALTER TABLE character_addictions MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  await Qi.addIndex('character_addictions', ['character_id', 'drug_class'], {
    name: 'uq_character_addictions_character_class',
    unique: true,
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('character_addictions');
}
