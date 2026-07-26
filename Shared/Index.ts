/**
 * Root barrel for the Shared workspace - the code compiled into the
 * server bundle, the client bundle and the NUI browser bundle alike, so
 * that wire contracts, tunable constants and chat formatting have exactly
 * one definition and cannot drift between the two ends of a net event.
 *
 * Two standing rules for anything under Shared/: it may not import from
 * Backend, Frontend or UI, and it may not touch a CitizenFX native or a
 * browser API. Both would break at least one of the three runtimes it
 * gets compiled into.
 *
 * This particular file is vestigial - no workspace imports `@Shared/Index.js`.
 * Consumers import the concrete module (`@Shared/Events/NetEvents.js`,
 * `@Shared/Constants/Inventory.js`) or, in the one case where a barrel is
 * genuinely used, `@Shared/Chat/Index.js`.
 */
export * from './Events/Index.js';
export * from './Constants/Index.js';
export * from './Chat/Index.js';
