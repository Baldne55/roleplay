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
 * Handheld-radio tuning state. `radio_state` carries the character's
 * power flag, main channel, and tuned slots as a JSON blob (see
 * Shared/Constants/Radio.ts). Nullable so existing characters need no
 * backfill - a null column reads as the default off / untuned state at
 * spawn (NormalizeRadioState). Written with the rest of the runtime on
 * disconnect, so no recurring job touches it.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.addColumn('characters', 'radio_state', {
    type: DataTypes.JSON,
    allowNull: true,
  });
}

/**
 * Drop the column added by Up, discarding whatever it held. Destructive -
 * the values are not recoverable afterwards.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.removeColumn('characters', 'radio_state');
}
