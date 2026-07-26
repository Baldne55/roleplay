import { DataTypes, type QueryInterface, type Sequelize } from 'sequelize';

/**
 * Umzug migration context. Carries the Sequelize instance whose
 * QueryInterface performs the schema change - migrations never touch the
 * application connection, which is not yet built when they run.
 */
interface Context {
  Sequelize: Sequelize;
}

/**
 * Add `hit_component` to `weapon_discharge_log`.
 *
 * The relayed `weaponDamageEvent` carries the numeric ped component
 * id the shot landed on; storing it per hit lets admins review raw
 * component distributions (`/ac stats`) for aimbot-shaped
 * concentration. The value stays an untranslated number on purpose -
 * no component-id-to-bone-name mapping is hardcoded anywhere.
 *
 *   - Nullable. Rows written before this column existed, and events
 *     that arrive without a usable component value, stay NULL.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();

  await Qi.addColumn('weapon_discharge_log', 'hit_component', {
    type: DataTypes.SMALLINT,
    allowNull: true,
  });
}

/**
 * Drop the column added by Up, discarding whatever it held. Destructive -
 * the values are not recoverable afterwards.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.removeColumn('weapon_discharge_log', 'hit_component');
}
