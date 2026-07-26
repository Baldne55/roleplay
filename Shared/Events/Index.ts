/**
 * Vestigial barrel over the three event-name namespaces - nothing imports
 * it; callers name the module directly (`@Shared/Events/NetEvents.js`).
 * Retained as a map of the three transport hops, one namespace each:
 *
 *   NetEvents    - server <-> client, over the FiveM network layer
 *                  (emitNet / onNet). Carries a typed payload map.
 *   NUIEvents    - client <-> NUI browser, over SendNuiMessage and
 *                  RegisterNuiCallback.
 *   ClientEvents - client-internal, between controllers in the same
 *                  runtime, where a direct reference would create a
 *                  circular import.
 *
 * The names are string constants rather than raw literals so that a
 * rename is a compile error on both ends of the hop instead of a message
 * that silently stops arriving.
 */
export * from './NetEvents.js';
export * from './NUIEvents.js';
export * from './ClientEvents.js';
