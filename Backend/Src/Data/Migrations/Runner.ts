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
 * No migrations exist yet - created when features land.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';

const Here = dirname(fileURLToPath(import.meta.url));

interface MigrationModule {
  Up: (Context: { Sequelize: Sequelize }) => Promise<void>;
  Down: (Context: { Sequelize: Sequelize }) => Promise<void>;
}

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

function BuildUmzug(Db: Sequelize): Umzug<{ Sequelize: Sequelize }> {
  return new Umzug({
    migrations: {
      glob: ['*.ts', { cwd: Here, ignore: ['Runner.ts'] }],
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

function Pad(N: number, Width: number): string {
  return N.toString().padStart(Width, '0');
}

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
  const Skeleton = `import { DataTypes, type QueryInterface } from 'sequelize';
import type { Sequelize } from 'sequelize';

interface Context { Sequelize: Sequelize }

export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  // TODO: schema changes
  void Qi;
  void DataTypes;
}

export async function Down({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  // TODO: reverse the change above
  void Qi;
}
`;
  writeFileSync(FullPath, Skeleton, { encoding: 'utf8' });
  console.log(`Created ${FileName}`);
}

async function Main(): Promise<void> {
  const [Command, ...Rest] = process.argv.slice(2);
  if (Command === 'generate') {
    Scaffold(Rest[0]);
    return;
  }
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
