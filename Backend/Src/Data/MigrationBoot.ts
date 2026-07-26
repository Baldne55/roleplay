/**
 * Boot-time migration gate. Runs every pending migration from the
 * static manifest before Bootstrap loads, so a fresh (empty) database
 * reaches the current schema on first server start and a deploy with
 * pending migrations self-applies them. Uses its own short-lived
 * Sequelize connection - Bootstrap's pooled instance comes up later.
 *
 * Shares the `schema_migrations` storage table with the CLI Runner, so
 * the two never re-apply each other's work.
 */
import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';
import { Logger } from '@/Util/Logger.js';
import { LoadServerConfig } from '@/Infrastructure/Config/ServerConfig.js';
import { MigrationManifest, type MigrationContext } from '@/Data/Migrations/Index.js';

const Log = Logger.New('Migrations');

/**
 * Apply outstanding schema migrations, before anything else touches the
 * database.
 *
 * Uses its own short-lived connection rather than the application's,
 * because it must run before the models are registered - the schema they
 * describe may not exist yet.
 *
 * Failing here should stop the boot: a resource that starts against a
 * half-migrated schema writes rows the next migration cannot reconcile.
 */
export async function RunPendingMigrations(): Promise<void> {
  const Config = LoadServerConfig();
  const Db = new Sequelize(Config.DBName, Config.DBUser, Config.DBPassword, {
    dialect: 'mysql',
    host: Config.DBHost,
    port: Config.DBPort,
    logging: false,
  });
  try {
    const U = new Umzug<MigrationContext>({
      migrations: MigrationManifest.map((Entry) => ({
        name: Entry.Name,
        up: async ({ context }) => Entry.Module.Up(context),
        down: async ({ context }) => Entry.Module.Down(context),
      })),
      context: { Sequelize: Db },
      storage: new SequelizeStorage({ sequelize: Db, tableName: 'schema_migrations' }),
      logger: undefined,
    });
    const Pending = await U.pending();
    if (Pending.length === 0) {
      Log.Info(`Schema up to date (${MigrationManifest.length} migrations applied).`);
      return;
    }
    Log.Info(
      `Applying ${Pending.length} pending migration(s): ${Pending.map((P) => P.name).join(', ')}`,
    );
    await U.up();
    Log.Info('Schema migrated to head.');
  } finally {
    await Db.close();
  }
}
