import type { Sequelize } from 'sequelize';

/**
 * Umzug migration context. Carries the Sequelize instance whose
 * QueryInterface performs the schema change - migrations never touch the
 * application connection, which is not yet built when they run.
 */
interface Context {
  Sequelize: Sequelize;
}

/**
 * `family_heirloom` and `key_vehicle` are retired from the item-type
 * catalog (the vehicle slice will mint its own key types when it
 * lands). Rows of a removed type would surface as `UnknownItemType`
 * on every interaction, so they are deleted outright - hard cutover.
 * The mutation log keeps their history; only live rows go.
 */
const RetiredTypeIDs = ['family_heirloom', 'key_vehicle'];

/**
 * Delete rows whose item types were retired from the catalog.
 *
 * Destructive and one-way: a row referencing a type the catalog no longer
 * defines cannot be rendered or used, so it is removed rather than left
 * as an unresolvable reference.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  for (const Table of ['inventory_items', 'ground_drops']) {
    await Sequelize.query(`DELETE FROM ${Table} WHERE item_type_id IN (?)`, {
      replacements: [RetiredTypeIDs],
    });
  }
}

/**
 * Irreversible by design - a deliberate no-op.
 *
 * Up deleted rows; they cannot be reconstructed, and restoring the
 * catalog entries without their rows would achieve nothing.
 */
export async function Down(): Promise<void> {
  // Intentionally empty - see the doc comment above.
}
