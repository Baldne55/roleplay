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
 * Item-type ID simplification sweep - hard cutover, no alias period.
 * Form suffixes drop (the display name keeps the form), slang IDs
 * expand to the canonical substance name, and the qualifier-prefixed
 * one-of-a-kind items lose their qualifiers:
 *
 *   ecstasy_pill     -> ecstasy
 *   oxy_pills        -> oxycodone
 *   whiskey_shot     -> whiskey
 *   wine_glass       -> wine
 *   water_bottle     -> water
 *   ecola_can        -> ecola
 *   sprunk_can       -> sprunk
 *   morphine_syringe -> morphine
 *   radio_handheld   -> radio
 *   paper_blank      -> paper
 *   personal_note    -> note
 *
 * None of these appear inside other rows' metadata, so only the
 * `item_type_id` columns move.
 */
const Renames: ReadonlyArray<readonly [string, string]> = [
  ['ecstasy_pill', 'ecstasy'],
  ['oxy_pills', 'oxycodone'],
  ['whiskey_shot', 'whiskey'],
  ['wine_glass', 'wine'],
  ['water_bottle', 'water'],
  ['ecola_can', 'ecola'],
  ['sprunk_can', 'sprunk'],
  ['morphine_syringe', 'morphine'],
  ['radio_handheld', 'radio'],
  ['paper_blank', 'paper'],
  ['personal_note', 'note'],
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
