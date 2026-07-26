/**
 * Vestigial barrel for the tunable-constants layer, covering three of the
 * seventeen modules. Nothing imports it - every consumer reaches for the
 * concrete module instead:
 *
 *   import { InventorySlotCapacity } from '@Shared/Constants/Inventory.js';
 *
 * That direct-path convention is the one to follow for new code. It keeps
 * the import line pointing at the file that actually defines the value,
 * which matters in a constants layer where names like `*BagKey` and
 * `*IntervalMs` recur across modules and a barrel import would obscure
 * which subsystem's tunable you picked up.
 *
 * Kept only because it is reachable from Shared/Index.js; safe to delete
 * along with that file once both are confirmed unreferenced.
 */
export * from './AuthSkybox.js';
export * from './Character.js';
export * from './AccountSettings.js';
