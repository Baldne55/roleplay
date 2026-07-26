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
  /** Soft red. ERROR severity, ADMIN broadcasts. */
  Error: '#FF8080',
  /** True orange. WARNING severity. Bright = attention. */
  Warning: '#FFA500',
  /** Clearer blue. INFO severity. */
  Info: '#5B9BFF',
  /** Light yellow. USAGE severity (shares the Highlight tone deliberately). */
  Usage: '#FFE066',
  /** Emerald. Feature-prefix brand (BANK:, BOOMBOX:, etc.) reads as
   * in-brand surface alongside the rest of the chat emerald (Cmd,
   * Header, Primary). Callers can override per-feature via the
   * optional colour arg on ChatFormatter.Brand. */
  Brand: '#10B981',
  /** Soft teal. Inline LABEL: tags AND /low verb tint. */
  Label: '#88E0E0',
  /** Standard green for $amount formatting. */
  Money: '#22C55E',
  /** Emerald. `/command` inline references - matches Primary so command names
   * read as in-brand surface throughout chat. */
  Cmd: '#10B981',
  /** Light yellow. Inline highlight emphasis AND full /pm / /dm / /reply / /rm
   * lines (the entire PM, including the names and body, renders in this). */
  Highlight: '#FFE066',
  /** Grayish. /b local OOC wrap. Designed to read as out-of-character
   * commentary that fades into the panel chrome rather than competing
   * with IC speech. */
  OOC: '#9CA3AF',
  /** /me, /do, /ame, /my IC actions. */
  RP: '#C2A2DA',
  /**
   * Directed-speech marker for /to, /shoutto, /wto. Rendered as a bright
   * pink-magenta `-> ` prefix on the TARGET's copy of the line only -
   * the bystanders in range see the same line without the marker. The
   * pinkish-purplish hue is deliberately distinct from every other chat
   * channel (yellow Highlight is PMs, purple RP is /me, white is speech)
   * so a player scanning chat finds "someone addressed me" at a glance.
   */
  Directed: '#FF66CC',
  /**
   * Quiet-channel full-line tints. /say and /shout render entirely white
   * (volume reads from the verb word "says" / "shouts"). /low and
   * /whisper carry these tints across the whole utterance so the muted
   * register reads at a glance.
   *
   *   Low     SpeechLow  #D1D5DB - full-line light gray, lowered volume.
   *   Whisper SpeechQuiet #FFCC99 - full-line pale orange, barely audible.
   */
  SpeechLow: '#D1D5DB',
  SpeechQuiet: '#FFCC99',
  /** Admin broadcasts - soft red, full-line, no `(( ))` wrap. */
  Admin: '#FF8080',
  /** Emerald. Block headers / sections / footers default to this so framed
   * blocks (welcome card, /help, /id) all read as branded surface. */
  Header: '#10B981',
  /**
   * PrimeVue Aura primary (emerald 500). Used to tint brand fragments
   * the chat shares with the SPA chrome (e.g. `.mp` in the welcome
   * line). Keep in sync with whatever override Main.ts passes to the
   * Aura preset; the default with no override is #10B981.
   */
  Primary: '#10B981',
  /** Cyan. Handheld-radio transmissions - tints the whole line so radio
   * traffic reads as its own channel, distinct from speech (white),
   * PMs (yellow) and /me (purple). */
  Radio: '#22D3EE',
  /** Indigo. Phone traffic (SMS, voicemail, over-the-line call speech) -
   * tints the whole phone line so it reads as its own channel, distinct
   * from radio cyan, PM yellow, /me purple and speech white. */
  Phone: '#818CF8',
  /** Default reset colour. The parser falls back to this between tokens. */
  White: '#FFFFFF',
} as const;

/** Semantic colour name from the palette. */
export type ChatColorName = keyof typeof ChatColor;
/** The `#RRGGBB` literal a palette name resolves to. */
export type ChatColorHex = (typeof ChatColor)[ChatColorName];
