/**
 * Shared chat domain types and helpers - consumed by Backend (to build
 * server-emitted messages) and UI (to parse tokens for span rendering).
 *
 * Wire format: token strings of the shape `!{#RRGGBB}body!{#FFFFFF}`. The
 * UI never sees raw HTML and never uses v-html; parsing happens at the
 * boundary in ChatTokens.Parse.
 */

export { ChatColor } from './ChatPalette.js';
export type { ChatColorName, ChatColorHex } from './ChatPalette.js';
export { Parse, Sanitize } from './ChatTokens.js';
export type { ChatSegment } from './ChatTokens.js';
export * as ChatFormatter from './ChatFormatter.js';
export { ChatRanges, ChatVerbs } from './ChatConstants.js';
export type { ChatType } from './ChatConstants.js';

/**
 * Command surface taxonomy. Drives chat help-screen grouping and the
 * suggestion box's per-category chip rendering. Lives in Shared because
 * both the Backend registry (which gates by category in some helpers)
 * and the UI suggestion box need the same string literals.
 */
export type CommandCategory = 'Chat' | 'RP' | 'Comms' | 'Admin' | 'Utility';

/**
 * Projection of a registered command pushed to the client after spawn.
 * Drives the chat-input autocomplete - the SPA filters by Name / Aliases
 * prefix and renders Params + Description in the suggestion box.
 */
export interface CommandHint {
  Name: string;
  Aliases: readonly string[];
  Params: string;
  Description: string;
  Category: CommandCategory;
}
