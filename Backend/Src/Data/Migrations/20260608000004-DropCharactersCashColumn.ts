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
 * Drop `characters.cash`. Paper currency moved to the inventory layer
 * in 0.5.0 (item type `cash`, stored as integer cents). `bank` and
 * `bank_restricted` stay - those persist on the row until the bank
 * slice reworks them.
 *
 * Round 4 wiped on 2026-05-26, so there is no production data to
 * migrate. The Down migration restores the column at `0.00` default
 * so a rollback leaves a usable column without claiming to recover
 * the lost balance.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.removeColumn('characters', 'cash');
}

/**
 * Re-add the `cash` column with a zero default.
 *
 * Restores the shape but not the data: the balances that lived here were
 * converted into inventory currency items by Up and are not read back.
 * Rolling back therefore leaves every character with a zero column
 * alongside the cash they now carry as items.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  await Qi.addColumn('characters', 'cash', {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    defaultValue: '0.00',
  });
}
