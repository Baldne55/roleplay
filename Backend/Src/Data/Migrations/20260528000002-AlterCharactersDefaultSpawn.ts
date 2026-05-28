import type { QueryInterface, Sequelize } from 'sequelize';

interface Context {
  Sequelize: Sequelize;
}

/**
 * Move the world-position columns on `characters` from nullable-with-NULL-
 * fallback to NOT NULL with the legacy roleplay_ragemp Airport coords as
 * the column default.
 *
 *   - Default = (-1038.700, -2738.600, 13.800, 0.000). Mirrors ragemp's
 *     "Airport" entry in the spawn-point picker (AccountHandler.cs:1891).
 *   - Backfill runs FIRST so the subsequent NOT NULL flip cannot reject
 *     pre-existing rows. Any character that was inserted under the old
 *     nullable schema lands at the Airport on next spawn.
 *   - Raw ALTER statements rather than QueryInterface.changeColumn:
 *     Sequelize's serializer emits subtly different SQL for DECIMAL
 *     defaults across dialects and we want the MariaDB statement
 *     pinned verbatim.
 */
export async function Up({ Sequelize }: Context): Promise<void> {
  const Qi: QueryInterface = Sequelize.getQueryInterface();
  void Qi;

  await Sequelize.query(
    `UPDATE characters
     SET position_x = -1038.700,
         position_y = -2738.600,
         position_z =    13.800,
         heading    =     0.000
     WHERE position_x IS NULL
        OR position_y IS NULL
        OR position_z IS NULL
        OR heading    IS NULL`,
  );

  await Sequelize.query(
    'ALTER TABLE characters MODIFY position_x DECIMAL(10,3) NOT NULL DEFAULT -1038.700',
  );
  await Sequelize.query(
    'ALTER TABLE characters MODIFY position_y DECIMAL(10,3) NOT NULL DEFAULT -2738.600',
  );
  await Sequelize.query(
    'ALTER TABLE characters MODIFY position_z DECIMAL(10,3) NOT NULL DEFAULT 13.800',
  );
  await Sequelize.query(
    'ALTER TABLE characters MODIFY heading DECIMAL(10,3) NOT NULL DEFAULT 0.000',
  );
}

export async function Down({ Sequelize }: Context): Promise<void> {
  await Sequelize.query('ALTER TABLE characters MODIFY position_x DECIMAL(10,3) NULL');
  await Sequelize.query('ALTER TABLE characters MODIFY position_y DECIMAL(10,3) NULL');
  await Sequelize.query('ALTER TABLE characters MODIFY position_z DECIMAL(10,3) NULL');
  await Sequelize.query('ALTER TABLE characters MODIFY heading DECIMAL(10,3) NULL');
}
