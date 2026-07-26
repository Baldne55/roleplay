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
 * Drug rows created before DefaultMetadata seeding carry no Quality /
 * Purity / strain profile. That is worse than cosmetic: the stack-merge
 * blend treats a missing Purity as zero, so merging a bare admin-given
 * stack into a real batch dilutes it toward nothing. Backfill the
 * catalog defaults onto rows that have NO metadata at all (rows with
 * any metadata are left untouched - they may be deliberately partial).
 *
 * JSON literals match SerialiseMetadata's canonical form (alphabetical
 * keys, no spaces) so the /item move byte-for-byte merge compare still
 * matches rows created after the seeding shipped.
 */
const Defaults: ReadonlyArray<readonly [string, string]> = [
  ['cocaine', '{"Purity":100,"Quality":"Standard"}'],
  ['crack', '{"Purity":100,"Quality":"Standard"}'],
  ['methamphetamine', '{"Purity":100,"Quality":"Standard"}'],
  ['heroin', '{"Purity":100,"Quality":"Standard"}'],
  ['ketamine', '{"Purity":100,"Quality":"Standard"}'],
  ['pcp', '{"Purity":100,"Quality":"Standard"}'],
  ['fentanyl', '{"Purity":100,"Quality":"Standard"}'],
  ['opium', '{"Purity":100,"Quality":"Standard"}'],
  ['marijuana', '{"CbdPercent":1,"StrainType":"Hybrid","ThcPercent":20}'],
  ['hashish', '{"Quality":"Standard","ThcPercent":40}'],
  ['ecstasy', '{"Quality":"Standard"}'],
  ['lsd', '{"Quality":"Standard"}'],
  ['mushrooms', '{"Quality":"Standard"}'],
  ['dmt', '{"Quality":"Standard"}'],
];

/**
 * The two tables that store item-type IDs. Any rename or retirement of a
 * type must touch BOTH: an item can be in a character inventory or lying
 * on the ground, and missing the second leaves orphaned rows that resolve
 * to no catalog entry.
 */
const Tables = ['inventory_items', 'ground_drops'];

/**
 * Seed default potency metadata onto existing drug rows.
 *
 * Rows predating the metadata schema have none, which would render as
 * blank quality and purity; this gives them the catalog defaults.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  for (const Table of Tables) {
    for (const [TypeID, Json] of Defaults) {
      await Sequelize.query(
        `UPDATE ${Table} SET metadata_json = ? WHERE item_type_id = ? AND metadata_json IS NULL`,
        { replacements: [Json, TypeID] },
      );
    }
  }
}

/**
 * Irreversible by design - a deliberate no-op.
 *
 * Once backfilled, seeded values are indistinguishable from ones a row
 * earned in play, so there is no safe rule for deciding what to strip.
 */
export async function Down(): Promise<void> {
  // Intentionally empty - see the doc comment above.
}
