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
 * The full weapon catalog generates component item types as one entry
 * per unique engine component hash (`comp_<canonical name>`), because
 * a single component (a shared suppressor, a grip) attaches to many
 * weapons. The three hand-written pistol component types are renamed
 * into that scheme - hard cutover, no alias period:
 *
 *   weapon_pistol_extended_clip -> comp_pistol_clip_02
 *   weapon_pistol_suppressor    -> comp_at_pi_supp_02
 *   weapon_pistol_flashlight    -> comp_at_pi_flsh
 *
 * Rows are touched in two places: `item_type_id` on loose component
 * rows (inventory + ground), and the `AttachedComponents` entries
 * inside weapon rows' `metadata_json`, which carry the component's
 * `ItemTypeID` as the durable identity the service re-resolves
 * hashes from.
 */
const Renames: ReadonlyArray<readonly [string, string]> = [
  ['weapon_pistol_extended_clip', 'comp_pistol_clip_02'],
  ['weapon_pistol_suppressor', 'comp_at_pi_supp_02'],
  ['weapon_pistol_flashlight', 'comp_at_pi_flsh'],
];

/**
 * The two tables that store item-type IDs. Any rename or retirement of a
 * type must touch BOTH: an item can be in a character inventory or lying
 * on the ground, and missing the second leaves orphaned rows that resolve
 * to no catalog entry.
 */
const Tables = ['inventory_items', 'ground_drops'];

/**
 * Apply a list of `[From, To]` id renames across every table that stores
 * an item_type_id - both inventory rows and ground drops, or an item
 * would keep its old id simply by lying on the floor when Up ran.
 */
async function Apply(Sequelize: Sequelize, Pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
  for (const Table of Tables) {
    for (const [From, To] of Pairs) {
      await Sequelize.query(`UPDATE ${Table} SET item_type_id = ? WHERE item_type_id = ?`, {
        replacements: [To, From],
      });
      // JSON.stringify output carries no spaces around the colon, so
      // the key-value pair is a stable literal substring.
      await Sequelize.query(
        `UPDATE ${Table} SET metadata_json = REPLACE(metadata_json, ?, ?) WHERE metadata_json LIKE ?`,
        {
          replacements: [
            `"ItemTypeID":"${From}"`,
            `"ItemTypeID":"${To}"`,
            `%"ItemTypeID":"${From}"%`,
          ],
        },
      );
    }
  }
}

/**
 * Apply the rename table forward, across inventory rows and ground drops.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  await Apply(Sequelize, Renames);
}

/**
 * Reverse every rename by swapping each pair and re-applying.
 *
 * Cleanly reversible: the rename is a pure relabelling of item_type_id,
 * so running it backwards restores the previous ids exactly. Any row
 * minted under the NEW id since Up ran is also renamed back, which is
 * the intended behaviour - the old id is what the catalog will expect.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  await Apply(
    Sequelize,
    Renames.map(([From, To]) => [To, From] as const),
  );
}
