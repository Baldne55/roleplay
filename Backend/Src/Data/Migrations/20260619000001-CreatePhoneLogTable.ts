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
 * Create the `phone_log` table - SMS, voicemail and call history for the
 * text-phone system.
 *
 * Rows are keyed by `owner_number` (a phone NUMBER = inventory item
 * serial), NOT by a character FK: history follows the handset through
 * trades/drops/pickups (a found phone exposes its history; the passcode
 * lock is a later slice), so a deleted character must not cascade these
 * rows away. An SMS / voicemail writes two rows - sender `Out` (read) and
 * recipient `In` (unread). Calls write a caller `Out` and a callee
 * `In`/`Missed`. No FK is intentional - do not "fix" it into one.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('phone_log', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    owner_number: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    kind: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    direction: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    peer_number: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    duration_sec: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    is_read: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
  });

  // Inbox / unread lookups: WHERE owner_number = ? AND kind = ? [AND is_read].
  await Qi.addIndex('phone_log', ['owner_number', 'kind', 'is_read'], {
    name: 'ix_phone_log_owner_kind_read',
  });
  // Log ordering: WHERE owner_number = ? ORDER BY created_at DESC.
  await Qi.addIndex('phone_log', ['owner_number', 'created_at'], {
    name: 'ix_phone_log_owner_created',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('phone_log');
}
