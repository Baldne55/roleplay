/**
 * Static migration manifest. The production backend is a single esbuild
 * bundle - the boot-time migration gate cannot glob-discover `.ts`
 * files at runtime the way the CLI Runner does, so every migration is
 * imported statically here and bundled in.
 *
 * RULES:
 *   - Entries stay in ascending timestamp order (Umzug applies the
 *     array in order).
 *   - `Name` keeps the `.ts` suffix - it must match the names already
 *     recorded in `schema_migrations` by the CLI Runner.
 *   - Every new migration file MUST be registered here; the CLI Runner
 *     refuses to run when the folder and this manifest disagree, so a
 *     forgotten entry is caught at the next `npm run migrate:*`.
 */
import type { Sequelize } from 'sequelize';
import * as M20260527000001 from './20260527000001-CreateAccountsTable.js';
import * as M20260527000002 from './20260527000002-CreateCharactersTable.js';
import * as M20260528000001 from './20260528000001-CreateCharacterOutfitsTable.js';
import * as M20260528000002 from './20260528000002-AlterCharactersDefaultSpawn.js';
import * as M20260528000003 from './20260528000003-AddAccountsSettings.js';
import * as M20260608000001 from './20260608000001-CreateInventoriesTable.js';
import * as M20260608000002 from './20260608000002-CreateInventoryItemsTable.js';
import * as M20260608000003 from './20260608000003-CreateInventoryMutationLogTable.js';
import * as M20260608000004 from './20260608000004-DropCharactersCashColumn.js';
import * as M20260608000005 from './20260608000005-CreateGroundDropsTable.js';
import * as M20260608000006 from './20260608000006-CreateWeaponDischargeLogTable.js';
import * as M20260608000007 from './20260608000007-CreateItemNameRequestsTable.js';
import * as M20260608000008 from './20260608000008-CreateInventoryDeathSnapshotsTable.js';
import * as M20260609000001 from './20260609000001-ExtendItemNameRequestsKindEnum.js';
import * as M20260610000001 from './20260610000001-RenameWeaponComponentItemTypeIDs.js';
import * as M20260610000002 from './20260610000002-DeleteRetiredItemTypes.js';
import * as M20260610000003 from './20260610000003-SplitPhoneItemTypes.js';
import * as M20260610000004 from './20260610000004-RenameDrugItemTypeIDs.js';
import * as M20260610000005 from './20260610000005-SimplifyItemTypeIDs.js';
import * as M20260610000006 from './20260610000006-BackfillDrugDefaultMetadata.js';
import * as M20260610000007 from './20260610000007-RecomputeAdjustedItemWeights.js';
import * as M20260611000001 from './20260611000001-CreateAnticheatViolationsTable.js';
import * as M20260611000002 from './20260611000002-AddDischargeLogHitComponent.js';
import * as M20260612000001 from './20260612000001-AddCharacterBloodAlcohol.js';
import * as M20260612000002 from './20260612000002-CreateCharacterAddictionsTable.js';
import * as M20260615000001 from './20260615000001-AddCharacterRadioState.js';
import * as M20260619000001 from './20260619000001-CreatePhoneLogTable.js';
import * as M20260619000002 from './20260619000002-AddCharacterActivePhoneSerial.js';

/** What a migration receives: the Sequelize instance to work through. */
export interface MigrationContext {
  Sequelize: Sequelize;
}

/**
 * The two functions every migration file must export. PascalCase by house
 * convention - Umzug's default resolver expects lowercase `up`/`down`,
 * which is why the Runner supplies a custom resolver.
 */
export interface MigrationModule {
  Up: (Context: MigrationContext) => Promise<void>;
  Down: (Context: MigrationContext) => Promise<void>;
}

/**
 * One manifest row. `Name` must match the filename exactly, `.ts` suffix
 * included - it is the key recorded in `schema_migrations`, so a
 * mismatch would make the CLI and the boot gate disagree about what has
 * already been applied.
 */
export interface MigrationEntry {
  readonly Name: string;
  readonly Module: MigrationModule;
}

/**
 * The ordered migration list the server's boot gate applies. Ascending by
 * timestamp; Umzug runs the array in order, so position is meaningful.
 */
export const MigrationManifest: readonly MigrationEntry[] = [
  { Name: '20260527000001-CreateAccountsTable.ts', Module: M20260527000001 },
  { Name: '20260527000002-CreateCharactersTable.ts', Module: M20260527000002 },
  { Name: '20260528000001-CreateCharacterOutfitsTable.ts', Module: M20260528000001 },
  { Name: '20260528000002-AlterCharactersDefaultSpawn.ts', Module: M20260528000002 },
  { Name: '20260528000003-AddAccountsSettings.ts', Module: M20260528000003 },
  { Name: '20260608000001-CreateInventoriesTable.ts', Module: M20260608000001 },
  { Name: '20260608000002-CreateInventoryItemsTable.ts', Module: M20260608000002 },
  { Name: '20260608000003-CreateInventoryMutationLogTable.ts', Module: M20260608000003 },
  { Name: '20260608000004-DropCharactersCashColumn.ts', Module: M20260608000004 },
  { Name: '20260608000005-CreateGroundDropsTable.ts', Module: M20260608000005 },
  { Name: '20260608000006-CreateWeaponDischargeLogTable.ts', Module: M20260608000006 },
  { Name: '20260608000007-CreateItemNameRequestsTable.ts', Module: M20260608000007 },
  { Name: '20260608000008-CreateInventoryDeathSnapshotsTable.ts', Module: M20260608000008 },
  { Name: '20260609000001-ExtendItemNameRequestsKindEnum.ts', Module: M20260609000001 },
  { Name: '20260610000001-RenameWeaponComponentItemTypeIDs.ts', Module: M20260610000001 },
  { Name: '20260610000002-DeleteRetiredItemTypes.ts', Module: M20260610000002 },
  { Name: '20260610000003-SplitPhoneItemTypes.ts', Module: M20260610000003 },
  { Name: '20260610000004-RenameDrugItemTypeIDs.ts', Module: M20260610000004 },
  { Name: '20260610000005-SimplifyItemTypeIDs.ts', Module: M20260610000005 },
  { Name: '20260610000006-BackfillDrugDefaultMetadata.ts', Module: M20260610000006 },
  { Name: '20260610000007-RecomputeAdjustedItemWeights.ts', Module: M20260610000007 },
  { Name: '20260611000001-CreateAnticheatViolationsTable.ts', Module: M20260611000001 },
  { Name: '20260611000002-AddDischargeLogHitComponent.ts', Module: M20260611000002 },
  { Name: '20260612000001-AddCharacterBloodAlcohol.ts', Module: M20260612000001 },
  { Name: '20260612000002-CreateCharacterAddictionsTable.ts', Module: M20260612000002 },
  { Name: '20260615000001-AddCharacterRadioState.ts', Module: M20260615000001 },
  { Name: '20260619000001-CreatePhoneLogTable.ts', Module: M20260619000001 },
  { Name: '20260619000002-AddCharacterActivePhoneSerial.ts', Module: M20260619000002 },
];
