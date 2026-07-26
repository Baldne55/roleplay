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
 * Blood-alcohol storage for the Widmark slice. `blood_alcohol_grams`
 * carries the character's remaining ethanol grams as of
 * `blood_alcohol_at`; elimination is computed lazily from that stamp
 * on every read (Shared/Constants/Alcohol.ts), so no recurring job
 * writes these columns. Drinking adds grams; the breathalyzer projects
 * them into a BAC percentage.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.addColumn('characters', 'blood_alcohol_grams', {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: '0.00',
  });
  await Qi.addColumn('characters', 'blood_alcohol_at', {
    type: DataTypes.DATE,
    allowNull: true,
  });
}

/**
 * Drop the column added by Up, discarding whatever it held. Destructive -
 * the values are not recoverable afterwards.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.removeColumn('characters', 'blood_alcohol_at');
  await Qi.removeColumn('characters', 'blood_alcohol_grams');
}
