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
 * Create the `anticheat_violations` table.
 *
 * Append-only evidence trail for the anti-cheat pipeline (Phase 0).
 * One row per detection report, snapshotting the detection type, the
 * trust tier, the applied weight, the per-session score after the
 * report, the pipeline action taken (None / Alert / Kick / Ban), the
 * detector's evidence payload, and the offender's position.
 *
 *   - `account_id` / `character_id` are nullable ON DELETE SET NULL -
 *     the trail outlives the holders. Both null is possible when a
 *     detection fires pre-spawn.
 *   - `evidence_json` is detection-specific and rendered for admins
 *     only - never parsed for logic.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('anticheat_violations', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    account_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'accounts', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    detection_type: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    tier: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    weight: {
      type: DataTypes.SMALLINT,
      allowNull: false,
    },
    session_score: {
      type: DataTypes.SMALLINT,
      allowNull: false,
    },
    action: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    evidence_json: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    world: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    occurred_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: literal('CURRENT_TIMESTAMP'),
    },
  });

  await Qi.addIndex('anticheat_violations', ['account_id'], {
    name: 'idx_anticheat_violations_account',
  });
  await Qi.addIndex('anticheat_violations', ['character_id'], {
    name: 'idx_anticheat_violations_character',
  });
  await Qi.addIndex('anticheat_violations', ['detection_type'], {
    name: 'idx_anticheat_violations_type',
  });
  await Qi.addIndex('anticheat_violations', ['occurred_at'], {
    name: 'idx_anticheat_violations_occurred_at',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('anticheat_violations');
}
