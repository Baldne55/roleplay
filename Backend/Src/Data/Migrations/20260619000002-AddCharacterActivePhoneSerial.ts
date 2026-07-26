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
 * Add `characters.active_phone_serial` - the serial (= phone number) of
 * the handset a character has set active for /phone commands when
 * carrying several. Nullable, no backfill: a null column means "no
 * active phone chosen", and the resolver falls back to the sole carried
 * handset (or asks the player to pick when carrying several). Written
 * eagerly on /phone main and re-validated against currently-held phones
 * before use.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.addColumn('characters', 'active_phone_serial', {
    type: DataTypes.STRING(32),
    allowNull: true,
  });
}

/**
 * Drop the column added by Up, discarding whatever it held. Destructive -
 * the values are not recoverable afterwards.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.removeColumn('characters', 'active_phone_serial');
}
