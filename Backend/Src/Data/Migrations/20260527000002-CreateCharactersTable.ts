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
 * Create the `characters` table.
 *
 *   - PK `id` BIGINT UNSIGNED auto-increment.
 *   - `(account_id, slot_id)` UNIQUE - slot number is per-account.
 *   - `(first_name, last_name)` UNIQUE across Active + Deleted; names
 *     stay reserved after soft delete (no second "John Doe" ever).
 *   - mask_id / dna_id / fingerprint_id / ssn_id / bank_account_number
 *     are 10-char Crockford base32 strings, each UNIQUE. Generator
 *     lives in Backend ForensicIDService.
 *   - appearance_data is a typed JSON blob (see
 *     Shared/Constants/Character.AppearanceData). NOT NULL - the
 *     editor returns a full payload at creation.
 *   - hp / ap / injury_status / bleeding_status persist verbatim and
 *     survive reconnect; the future injury system handles revival.
 *   - position columns nullable - SpawnService picks a default when
 *     a character has never spawned. Save is event-driven
 *     (playerDropped + character switch), not on a recurring tick.
 *   - CASCADE on account delete; bans / admin punishments live on the
 *     account row, not here.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('characters', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    account_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'accounts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    slot_id: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    first_name: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    last_name: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    birth_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    gender: {
      type: DataTypes.ENUM('Male', 'Female'),
      allowNull: false,
    },
    blood_type: {
      type: DataTypes.ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('Active', 'Deleted'),
      allowNull: false,
      defaultValue: 'Active',
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    mask_id: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    dna_id: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    fingerprint_id: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    ssn_id: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    bank_account_number: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    height_cm: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    weight_kg: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    physical_description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    clothing_description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    appearance_data: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    is_masked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    hp: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 100,
    },
    ap: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    injury_status: {
      type: DataTypes.ENUM('Healthy', 'Unconscious', 'BadlyWounded', 'Dead'),
      allowNull: false,
      defaultValue: 'Healthy',
    },
    bleeding_status: {
      type: DataTypes.ENUM('NotBleeding', 'LightBleeding', 'MediumBleeding', 'HeavyBleeding'),
      allowNull: false,
      defaultValue: 'NotBleeding',
    },
    world: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    position_x: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
    },
    position_y: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
    },
    position_z: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
    },
    heading: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
    },
    cash: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: '0.00',
    },
    bank: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: '0.00',
    },
    bank_restricted: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: '0.00',
    },
    level: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    experience_points: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    daily_xp_earned: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    daily_xp_reset_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    weekly_xp_earned: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    weekly_xp_reset_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    monthly_xp_earned: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    monthly_xp_reset_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    playtime_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    creation_ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    last_login_at: {
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

  // Sequelize's createTable doesn't emit MariaDB's `ON UPDATE
  // CURRENT_TIMESTAMP` shortcut. Patch it.
  await Sequelize.query(
    'ALTER TABLE characters MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  );

  // Per-account slot uniqueness; UI shows Slot 1 / Slot 2 / ...
  await Qi.addIndex('characters', ['account_id', 'slot_id'], {
    name: 'uq_characters_account_slot',
    unique: true,
  });

  // Global IC name reservation across Active + Deleted - no second
  // "John Doe" can ever be created.
  await Qi.addIndex('characters', ['first_name', 'last_name'], {
    name: 'uq_characters_full_name',
    unique: true,
  });

  // Forensic + financial IDs - 10-char Crockford base32, each unique.
  await Qi.addIndex('characters', ['mask_id'], {
    name: 'uq_characters_mask_id',
    unique: true,
  });
  await Qi.addIndex('characters', ['dna_id'], {
    name: 'uq_characters_dna_id',
    unique: true,
  });
  await Qi.addIndex('characters', ['fingerprint_id'], {
    name: 'uq_characters_fingerprint_id',
    unique: true,
  });
  await Qi.addIndex('characters', ['ssn_id'], {
    name: 'uq_characters_ssn_id',
    unique: true,
  });
  await Qi.addIndex('characters', ['bank_account_number'], {
    name: 'uq_characters_bank_account_number',
    unique: true,
  });

  // Character-list query (per account, filtered by status).
  await Qi.addIndex('characters', ['account_id', 'status'], {
    name: 'idx_characters_account_status',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('characters');
}
