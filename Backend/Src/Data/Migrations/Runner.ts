/**
 * Migration runner. Umzug-backed CLI invoked via:
 *
 *   npm run migrate:up        # apply pending
 *   npm run migrate:down      # roll back one
 *   npm run migrate:status    # list pending + executed
 *   npm run migrate:generate -- AddFooTable
 *
 * Migrations live in this same folder as `<timestamp>-<name>.ts`. Each file
 * exports `Up(Context)` and `Down(Context)` taking a Sequelize QueryInterface.
 *
 * This CLI glob-discovers those files, while the server's boot gate runs
 * from the static manifest in Index.ts - a production bundle cannot glob
 * `.ts` at runtime. AssertManifestComplete below reconciles the two and
 * refuses to run when they disagree, so a migration missing from the
 * manifest is caught here rather than on a server that cannot apply it.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';
import { MigrationManifest } from './Index.js';

/**
 * This file's own directory - also the migrations directory, since the
 * runner sits alongside them. Used by the CLI's glob discovery and by the
 * scaffold writer. Derived from import.meta.url rather than process.cwd()
 * because the CLI can be invoked from anywhere in the repo.
 */
const Here = dirname(fileURLToPath(import.meta.url));

/**
 * Shape a migration file must export - matched structurally at load time,
 * so a file missing either half is rejected before Umzug runs it.
 */
interface MigrationModule {
  Up: (Context: { Sequelize: Sequelize }) => Promise<void>;
  Down: (Context: { Sequelize: Sequelize }) => Promise<void>;
}

/**
 * Build the CLI's own database connection from convar-equivalent env
 * config. Separate from the application connection, which does not exist
 * in a CLI process.
 */
function BuildSequelize(): Sequelize {
  const Host = process.env['DB_HOST'] ?? '127.0.0.1';
  const Port = Number(process.env['DB_PORT'] ?? '3306');
  const User = process.env['DB_USER'] ?? 'root';
  const Pass = process.env['DB_PASSWORD'] ?? '';
  const Name = process.env['DB_NAME'] ?? 'roleplay';
  return new Sequelize(Name, User, Pass, {
    dialect: 'mysql',
    host: Host,
    port: Port,
    logging: false,
  });
}

/**
 * Configure Umzug against the migrations folder, recording applied names
 * in `schema_migrations`.
 *
 * That table is shared with the server's boot gate, which is why the
 * glob-discovered names here must match the manifest's entries exactly -
 * including the `.ts` suffix.
 */
function BuildUmzug(Db: Sequelize): Umzug<{ Sequelize: Sequelize }> {
  return new Umzug({
    migrations: {
      glob: ['*.ts', { cwd: Here, ignore: ['Runner.ts', 'Index.ts'] }],
      // Custom resolver: project convention is PascalCase exports (Up/Down)
      // for consistency with the rest of the codebase. Umzug's default
      // resolver looks for lowercase `up`/`down`, so we map manually here.
      resolve: ({ name, path }) => {
        if (path === undefined) {
          throw new Error(`Migration ${name} is missing a path`);
        }
        const FileUrl = pathToFileURL(path).href;
        return {
          name,
          up: async ({ context }): Promise<void> => {
            const Module = (await import(FileUrl)) as MigrationModule;
            await Module.Up(context);
          },
          down: async ({ context }): Promise<void> => {
            const Module = (await import(FileUrl)) as MigrationModule;
            await Module.Down(context);
          },
        };
      },
    },
    context: { Sequelize: Db },
    storage: new SequelizeStorage({ sequelize: Db, tableName: 'schema_migrations' }),
    logger: console,
  });
}

/**
 * The server's boot-time migration gate runs from the static manifest
 * in Index.ts (the production bundle cannot glob `.ts` files), while
 * this CLI glob-discovers the folder. Refuse to run when the two
 * disagree, so a migration file that never made it into the manifest
 * is caught at the next CLI invocation instead of silently shipping a
 * server that cannot apply it.
 */
function AssertManifestComplete(): void {
  const Files = readdirSync(Here).filter((F) => /^\d{14}-.+\.ts$/.test(F));
  const Indexed = new Set(MigrationManifest.map((M) => M.Name));
  const Missing = Files.filter((F) => !Indexed.has(F));
  const Stale = [...Indexed].filter((N) => !Files.includes(N));
  if (Missing.length === 0 && Stale.length === 0) return;
  if (Missing.length > 0) {
    console.error(`Migration file(s) not registered in Index.ts: ${Missing.join(', ')}`);
  }
  if (Stale.length > 0) {
    console.error(`Index.ts entries without a matching file: ${Stale.join(', ')}`);
  }
  console.error('Fix the manifest in Src/Data/Migrations/Index.ts before running migrations.');
  process.exit(1);
}

/** Zero-pad a number to `Width` digits, for the UTC filename timestamp. */
function Pad(N: number, Width: number): string {
  return N.toString().padStart(Width, '0');
}

/**
 * Create a new timestamped migration file from the skeleton
 * (`npm run migrate:generate -- <Name>`).
 *
 * The timestamp is UTC so files sort identically regardless of the
 * author's timezone - ordering is what Umzug applies them in. Refuses to
 * overwrite an existing file, and reminds the author to register the new
 * migration in the static manifest, without which the server's boot gate
 * will not see it.
 */
function Scaffold(NameArg: string | undefined): void {
  if (NameArg === undefined || NameArg.length === 0) {
    console.error('Usage: npm run migrate:generate -- <Name>');
    process.exit(1);
  }
  const Now = new Date();
  const Stamp =
    Now.getUTCFullYear().toString() +
    Pad(Now.getUTCMonth() + 1, 2) +
    Pad(Now.getUTCDate(), 2) +
    Pad(Now.getUTCHours(), 2) +
    Pad(Now.getUTCMinutes(), 2) +
    Pad(Now.getUTCSeconds(), 2);
  const FileName = `${Stamp}-${NameArg}.ts`;
  const FullPath = join(Here, FileName);
  if (existsSync(FullPath)) {
    console.error(`Migration ${FileName} already exists`);
    process.exit(1);
  }
  mkdirSync(Here, { recursive: true });
  // Skeleton carries the same doc conventions as the existing
  // migrations, so a generated file starts documented rather than
  // needing them added afterwards.
  const Skeleton = `/**
 * TODO: one-line summary of what this migration changes.
 *
 * Note anything irreversible or lossy here - a reader deciding whether it
 * is safe to roll back should not have to infer that from the code.
 */
import { DataTypes, type QueryInterface } from 'sequelize';
import type { Sequelize } from 'sequelize';

/**
 * Umzug migration context. Carries the Sequelize instance whose
 * QueryInterface performs the schema change - migrations never touch the
 * application connection, which is not yet built when they run.
 */
interface Context { Sequelize: Sequelize }

/** TODO: describe the forward change. */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  // TODO: schema changes
  void Qi;
  void DataTypes;
}

/** TODO: describe the rollback, and say so plainly if it loses data. */
export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  // TODO: reverse the change above
  void Qi;
}
`;
  writeFileSync(FullPath, Skeleton, { encoding: 'utf8' });
  console.log(`Created ${FileName}`);
  console.log(
    'Register it in Src/Data/Migrations/Index.ts - the static manifest the server boot gate runs from.',
  );
}

/**
 * CLI entry point: dispatches `generate`, `up`, `down` and `status`.
 *
 * Unlike the server's boot gate, this discovers migrations by globbing
 * the folder - which is also what lets it detect a file missing from the
 * static manifest and refuse to run.
 */
async function Main(): Promise<void> {
  const [Command, ...Rest] = process.argv.slice(2);
  if (Command === 'generate') {
    Scaffold(Rest[0]);
    return;
  }
  AssertManifestComplete();
  const Db = BuildSequelize();
  const U = BuildUmzug(Db);
  try {
    switch (Command) {
      case 'up': {
        const Applied = await U.up();
        console.log(`Applied ${Applied.length} migration(s).`);
        break;
      }
      case 'down': {
        const Reverted = await U.down();
        console.log(`Reverted ${Reverted.length} migration(s).`);
        break;
      }
      case 'status': {
        const Pending = await U.pending();
        const Executed = await U.executed();
        console.log(`Executed: ${Executed.map((M) => M.name).join(', ') || '(none)'}`);
        console.log(`Pending:  ${Pending.map((M) => M.name).join(', ') || '(none)'}`);
        break;
      }
      default: {
        console.error(`Unknown command: ${Command ?? '(none)'}`);
        console.error('Usage: migrate <up|down|status|generate <Name>>');
        process.exitCode = 1;
      }
    }
  } finally {
    await Db.close();
  }
}

void Main();
