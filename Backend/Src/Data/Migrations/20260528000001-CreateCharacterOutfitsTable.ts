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
 * Create the `character_outfits` table.
 *
 *   - PK `id` BIGINT UNSIGNED auto-increment - matches the rest of the
 *     schema's BIGINT identity style; the requirement's "UUID PK" was a
 *     dialect-agnostic description, and MariaDB does not natively store
 *     UUIDs.
 *   - `character_id` FK -> characters.id ON DELETE CASCADE. A deleted
 *     character drags every wardrobe entry with it.
 *   - `name` VARCHAR(32) NOT NULL - app-level OutfitNameRegex enforces
 *     content; DB just caps the length.
 *   - `is_active` BOOLEAN - exactly one row per character carries TRUE.
 *     MariaDB lacks partial unique indexes, so the rule is enforced at
 *     the service / repository layer (per the spec's note).
 *   - `outfit_data` JSON NOT NULL - typed OutfitData blob (see
 *     Shared/Constants/Outfit.OutfitData).
 *   - Index on (character_id, is_active) accelerates the "find this
 *     character's currently-equipped outfit" lookup the spawn /
 *     wardrobe path will run on every connect.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('character_outfits', {
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
    name: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    outfit_data: {
      type: DataTypes.JSON,
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

  // Sequelize's createTable doesn't emit MariaDB's `ON UPDATE
  // CURRENT_TIMESTAMP` shortcut. Patch it.
  await Sequelize.query(
    'ALTER TABLE character_outfits MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  // Active-outfit lookup: every spawn / wardrobe load filters by
  // (character_id, is_active=TRUE).
  await Qi.addIndex('character_outfits', ['character_id', 'is_active'], {
    name: 'idx_character_outfits_character_active',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('character_outfits');
}
