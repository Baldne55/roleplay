import type { QueryInterface, Sequelize } from 'sequelize';

interface Context {
  Sequelize: Sequelize;
}

/**
 * Add a free-form `settings` JSON column to `accounts` for per-account
 * preferences (theme mode now; chat font, hud toggles, etc. later).
 *
 *   - Nullable. Fresh rows write NULL; lazy-merge against
 *     DefaultAccountSettings in the resolver makes that equivalent to
 *     "everything default".
 *   - JSON (not LONGTEXT). MariaDB stores as LONGTEXT under the hood with
 *     a CHECK json_valid constraint - mysql2 round-trips it as a parsed
 *     object so the model surface stays typed.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  void Qi;

  await Sequelize.query('ALTER TABLE accounts ADD COLUMN settings JSON NULL');
}

export async function Down({ Sequelize }: Context): Promise<void> {
  await Sequelize.query('ALTER TABLE accounts DROP COLUMN settings');
}
