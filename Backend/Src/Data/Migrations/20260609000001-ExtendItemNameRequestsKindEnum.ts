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
 * Extend the `item_name_requests.kind` enum to include 'Deface', so
 * the unified moderation queue covers serial-removal requests
 * alongside Name + Description (mirrors the /renameitem +
 * /describeitem flow; approved via the same /aapproveitemrequest).
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  await Sequelize.query(
    "ALTER TABLE item_name_requests MODIFY COLUMN kind ENUM('Name','Description','Deface') NOT NULL",
  );
}

/**
 * Narrow the `kind` enum back to its original two members.
 *
 * MySQL silently blanks any row holding a value the narrowed enum no
 * longer permits, so pending requests of a newly-added kind are lost on
 * rollback rather than blocking it.
 */
export async function Down({ Sequelize }: Context): Promise<void> {
  await Sequelize.query(
    "ALTER TABLE item_name_requests MODIFY COLUMN kind ENUM('Name','Description') NOT NULL",
  );
}
