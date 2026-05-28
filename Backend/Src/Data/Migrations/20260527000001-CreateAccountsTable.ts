import { DataTypes, literal, type QueryInterface, type Sequelize } from 'sequelize';

interface Context {
  Sequelize: Sequelize;
}

/**
 * Create the `accounts` table.
 *
 *   - PK `id` BIGINT UNSIGNED auto-increment (room to grow).
 *   - `license` (FXServer player identifier) UNIQUE NOT NULL - the primary
 *     lookup key on every connect.
 *   - `discord_id` BIGINT UNSIGNED UNIQUE NULL - Discord snowflake, stored
 *     as a 64-bit integer (NOT a string; snowflakes overflow JS Number but
 *     mysql2 returns BIGINT as string by default which is fine).
 *   - Discord profile cache (username/display name/avatar/email) so the UI
 *     does not have to re-fetch every refresh.
 *   - Status / staff / premium tier as MariaDB ENUMs - readable in
 *     ad-hoc SQL and cheap.
 *   - `premium_expires_at NULL` means "permanent" when `premium_tier <>
 *     'None'`. A CHECK constraint enforces consistency.
 *   - Timestamps managed via Sequelize convention (`created_at` /
 *     `updated_at` with ON UPDATE).
 *   - Soft delete via `is_deleted`.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('accounts', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    license: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    discord_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      unique: true,
    },
    discord_username: {
      type: DataTypes.STRING(48),
      allowNull: true,
    },
    discord_display_name: {
      type: DataTypes.STRING(48),
      allowNull: true,
    },
    discord_avatar: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    discord_email: {
      type: DataTypes.STRING(254),
      allowNull: true,
    },
    last_social_club_name: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    last_ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    registration_ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('Pending', 'Active', 'Banned'),
      allowNull: false,
      defaultValue: 'Pending',
    },
    staff_level: {
      type: DataTypes.ENUM('None', 'Helper', 'Moderator', 'Administrator', 'Founder'),
      allowNull: false,
      defaultValue: 'None',
    },
    premium_tier: {
      type: DataTypes.ENUM('None', 'Bronze', 'Silver', 'Gold', 'Platinum'),
      allowNull: false,
      defaultValue: 'None',
    },
    premium_expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    last_oauth_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    first_login_at: {
      type: DataTypes.DATE,
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
    is_deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  });

  // Sequelize's createTable doesn't emit MariaDB's `ON UPDATE
  // CURRENT_TIMESTAMP` shortcut for the updated_at column. Patch it.
  await Sequelize.query(
    "ALTER TABLE accounts MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  );

  // Enforce: a None tier MUST have a null expiry. Rules out the
  // "None + 2027-01-01" footgun the service layer would otherwise have to
  // remember. MariaDB enforces CHECK since 10.2.
  await Sequelize.query(
    "ALTER TABLE accounts ADD CONSTRAINT ck_accounts_premium_consistency CHECK (premium_tier <> 'None' OR premium_expires_at IS NULL)",
  );

  // Composite + recency indexes for admin queries.
  await Qi.addIndex('accounts', ['status', 'staff_level'], {
    name: 'idx_accounts_status_staff',
  });
  await Qi.addIndex('accounts', ['last_login_at'], {
    name: 'idx_accounts_last_login',
  });
}

export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('accounts');
}
