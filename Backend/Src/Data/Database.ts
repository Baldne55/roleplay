/**
 * Sequelize connection factory. Single Sequelize instance per backend
 * process; models register via sequelize-typescript decorators and are
 * attached during Bootstrap before any service uses them.
 *
 * The actual `new Sequelize(...)` call lives in Bootstrap so the connection
 * lifecycle is centralised. Services receive the instance via tsyringe DI.
 */
import { Sequelize } from 'sequelize-typescript';
import type { ServerConfig } from '@/Infrastructure/Config/ServerConfig.js';

/**
 * Build the application's Sequelize connection from resolved config.
 *
 * One instance for the process lifetime, constructed in Bootstrap and
 * threaded into the repositories - InventoryService also holds it
 * directly, since it opens explicit transactions around composite
 * mutations.
 *
 * Distinct from the throwaway connection MigrationBoot creates: that one
 * runs before models are registered and is closed immediately after.
 */
export function CreateSequelize(Config: ServerConfig): Sequelize {
  return new Sequelize({
    dialect: 'mysql',
    host: Config.DBHost,
    port: Config.DBPort,
    username: Config.DBUser,
    password: Config.DBPassword,
    database: Config.DBName,
    logging: false,
    define: {
      // Columns + tables are snake_case at the DB layer; the TS classes stay
      // PascalCase (mapped per-field via `@Column({ field: 'snake_name' })`).
      underscored: true,
      freezeTableName: false,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    pool: {
      max: 10,
      min: 0,
      idle: 10000,
      acquire: 30000,
    },
    // models: [] - registered in Bootstrap once feature models exist.
  });
}
