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
 * Create the `weapon_discharge_log` table.
 *
 * Forensic ledger of every damage event where a weapon hits a ped.
 * Source: server-side `weaponDamageEvent` hook (decision 42). One
 * row per hit.
 *
 *   - `transaction_id` joins to the matching `inventory_mutation_log`
 *     WeaponShot row so investigators can pivot from "this weapon
 *     discharged here" to "this character was holding it on this
 *     Source at the time".
 *   - `unique_serial` is the weapon's *stored* serial at moment of
 *     fire - a later /adefaceserial nulls the weapon row's column
 *     but never edits the historical discharge row.
 *   - `shooter_character_id` / `victim_character_id` are nullable
 *     ON DELETE SET NULL - the trail outlives the holders.
 *   - Append-only; no updated_at.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.createTable('weapon_discharge_log', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    transaction_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
    },
    weapon_serial: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    weapon_type_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    ammo_type_id: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    shooter_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    victim_character_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'characters', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    damage: {
      type: DataTypes.SMALLINT,
      allowNull: false,
    },
    world: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    position_x: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
    },
    position_y: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
    },
    position_z: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: false,
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

  await Qi.addIndex('weapon_discharge_log', ['weapon_serial'], {
    name: 'idx_discharge_log_weapon_serial',
  });
  await Qi.addIndex('weapon_discharge_log', ['transaction_id'], {
    name: 'idx_discharge_log_transaction_id',
  });
  await Qi.addIndex('weapon_discharge_log', ['shooter_character_id'], {
    name: 'idx_discharge_log_shooter',
  });
  await Qi.addIndex('weapon_discharge_log', ['victim_character_id'], {
    name: 'idx_discharge_log_victim',
  });
  await Qi.addIndex('weapon_discharge_log', ['occurred_at'], {
    name: 'idx_discharge_log_occurred_at',
  });
}

/**
 * Drop the table, discarding every row in it. Destructive: rolling this
 * migration back is a data-loss operation, not a safe undo.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.dropTable('weapon_discharge_log');
}
