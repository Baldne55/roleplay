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
 * Nine catalog weights were corrected toward realism (drinks now count
 * their vessel, a few tools were off by feel). `weight_grams` is
 * denormalised per row (unit weight x stack), so existing rows of the
 * adjusted types are recomputed to keep carry-weight sums honest.
 */
const AdjustedUnitWeights: ReadonlyArray<readonly [string, number]> = [
  ['beer', 550],
  ['whiskey', 140],
  ['wine', 280],
  ['donut', 70],
  ['boltcutters', 2500],
  ['camera', 1200],
  ['zipties', 50],
  ['wallet', 100],
  ['breathalyzer', 300],
];

/**
 * The two tables that store item-type IDs. Any rename or retirement of a
 * type must touch BOTH: an item can be in a character inventory or lying
 * on the ground, and missing the second leaves orphaned rows that resolve
 * to no catalog entry.
 */
const Tables = ['inventory_items', 'ground_drops'];

/**
 * Recompute stored item weights from the catalog.
 *
 * WeightGrams is a denormalised snapshot, so a catalog weight change
 * leaves existing rows stale until a pass like this recomputes them.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  for (const Table of Tables) {
    for (const [TypeID, UnitGrams] of AdjustedUnitWeights) {
      await Sequelize.query(
        `UPDATE ${Table} SET weight_grams = ? * COALESCE(stack_quantity, 1) WHERE item_type_id = ?`,
        { replacements: [UnitGrams.toFixed(2), TypeID] },
      );
    }
  }
}

/**
 * Intentional no-op.
 *
 * Weights are recomputed forward from the catalog by the next
 * correction, so restoring the previous (incorrect) values serves
 * nothing.
 */
export async function Down(): Promise<void> {
  // Intentionally empty - see the doc comment above.
}
