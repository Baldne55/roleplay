/**
 * Hex palette for chat v2 (see chat_visual_v2_spec.md, locked 2026-05-07).
 *
 * Format on the wire is always `!{#RRGGBB}` token strings. These constants
 * are the source of truth on both Backend (which builds messages) and UI
 * (which parses tokens for span rendering).
 *
 * The same hex appears across multiple roles by design - e.g. ERROR and
 * ADMIN are both #FF8080 - so don't dedupe; the role name is the call-site
 * intent.
 */
export const ChatColor = {
  Error: '#FF8080',
  Warning: '#FFB07A',
  Info: '#88AAFF',
  Usage: '#FFA0A0',
  /** Saturated red, used as the default Brand colour. */
  Brand: '#E63946',
  Label: '#88E0E0',
  Money: '#88DD88',
  Cmd: '#FF6F6F',
  Highlight: '#FFE066',
  OOC: '#3A7BD5',
  /** /me, /do, /ame, /my IC actions. */
  RP: '#C2A2DA',
  /** Admin broadcasts + block headers/sections/footers - all soft red. */
  Admin: '#FF8080',
  Header: '#FF8080',
  /**
   * PrimeVue Aura primary (emerald 500). Used to tint brand fragments
   * the chat shares with the SPA chrome (e.g. `.mp` in the welcome
   * line). Keep in sync with whatever override Main.ts passes to the
   * Aura preset; the default with no override is #10B981.
   */
  Primary: '#10B981',
  /** Default reset colour. The parser falls back to this between tokens. */
  White: '#FFFFFF',
} as const;

export type ChatColorName = keyof typeof ChatColor;
export type ChatColorHex = (typeof ChatColor)[ChatColorName];
