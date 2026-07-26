/**
 * Backend entry point. Loaded by FXServer via `server_script 'Dist/Backend.js'`
 * in fxmanifest.lua.
 *
 * Migrations gate the boot: the schema reaches head before any service,
 * controller, or net-event handler exists, so a fresh database populates
 * itself on first start. A failed migration refuses to load Bootstrap at
 * all - better an inert resource and a loud error than a backend running
 * against a half-applied schema.
 */
import { Logger } from '@/Util/Logger.js';
import { RunPendingMigrations } from '@/Data/MigrationBoot.js';

// The Backend once raised EventEmitter.defaultMaxListeners here: fourteen
// per-service `on('playerDropped')` registrations tripped the default
// warning ceiling of ten on every boot. They are consolidated into the
// single PlayerSessionService dispatcher now, so the busiest event name
// (playerJoining) carries two listeners and the default ceiling holds.
// If a future event legitimately crosses ten one-time constructor
// registrations, consolidate it the same way before reaching for the
// ceiling again.

const Log = Logger.New('Index');

RunPendingMigrations()
  .then(() => import('./Bootstrap.js'))
  .catch((Err: unknown) => {
    Log.Error('Database migration failed - backend NOT started.', { Err: String(Err) });
  });
