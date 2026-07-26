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
 * The single generic `phone` type splits into three handset tiers
 * (`phone_ifruit`, `phone_badger`, `phone_celltowa`) - hard cutover.
 * Existing rows become the Celltowa push-button handset: the generic
 * 'Cell Phone' was the starter-tier device, and smartphones should
 * enter the economy deliberately, not by rename. Serials (phone
 * numbers) ride along untouched.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  for (const Table of ['inventory_items', 'ground_drops']) {
    await Sequelize.query(
      `UPDATE ${Table} SET item_type_id = 'phone_celltowa' WHERE item_type_id = 'phone'`,
    );
  }
}

/**
 * Collapse every Celltowa handset back into the generic `phone` type.
 *
 * Lossy in one direction: handsets minted as `phone_celltowa` *after* the
 * split are folded in too, since nothing distinguishes them from ones the
 * split created. Re-running Up would not separate them again.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  for (const Table of ['inventory_items', 'ground_drops']) {
    await Sequelize.query(
      `UPDATE ${Table} SET item_type_id = 'phone' WHERE item_type_id = 'phone_celltowa'`,
    );
  }
}
