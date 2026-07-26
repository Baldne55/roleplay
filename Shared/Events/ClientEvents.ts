/**
 * Client-local events — same-client emit/on only, NEVER networked.
 *
 * A third registry beside NetEvents (FiveM net protocol) and NUIEvents
 * (NUI postMessage): these cross neither boundary. They exist so
 * Frontend controllers can sequence against each other's lifecycles
 * without polling — the emitter and every listener live in the same
 * client resource, so no payload here is ever hostile.
 *
 * Format: `Roleplay:Client:<Domain>:<VerbNoun>` (PascalCase, all-caps acronyms).
 */
export const ClientEvents = {
  /**
   * Fired after SpawnIntoWorld finishes the SetPlayerModel swap plus
   * the appearance / outfit application. A model swap silently clears
   * per-ped state (movement clipsets among it), so controllers that
   * own such state listen here and re-apply it rather than guessing
   * when the dressing pass has settled.
   */
  SpawnDressingComplete: 'Roleplay:Client:Spawn:DressingComplete',
} as const;

/** Any client-internal event name; derived from the constants so the two cannot drift. */
export type ClientEventName = (typeof ClientEvents)[keyof typeof ClientEvents];
