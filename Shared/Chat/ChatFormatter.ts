import { ChatColor } from './ChatPalette.js';
import { ChatVerbs, type ChatType } from './ChatConstants.js';

/**
 * Build chat token strings for the canonical v2 format. Mirrors lc-rp's
 * C# ChatFormatter helper surface, scoped to what we ship this slice.
 *
 * Every returned string ends with a `!{#FFFFFF}` reset token so trailing
 * brackets / unstyled tails render white regardless of how the parser
 * threads state forward.
 *
 * Caps rules (per chat_visual_v2_spec.md):
 *   - Severity tags, brand prefixes, header / section / inline labels:
 *     ALL CAPS.
 *   - Body sentences, value text, dynamic content: sentence case / as-is.
 * Callers pass the body verbatim; helpers handle the tag side.
 */

/** Block width for Header / Section / Footer / Divider lines. */
const BlockWidth = 60;

// ── Severity wraps ─────────────────────────────────────────────────────

function Severity(Tag: string, Color: string, Body: string): string {
  return `(( !{${Color}}${Tag}:!{${ChatColor.White}} ${Body} ))`;
}

export function Error(Body: string): string {
  return Severity('ERROR', ChatColor.Error, Body);
}

export function Warning(Body: string): string {
  return Severity('WARNING', ChatColor.Warning, Body);
}

export function Info(Body: string): string {
  return Severity('INFO', ChatColor.Info, Body);
}

export function Usage(Body: string): string {
  return Severity('USAGE', ChatColor.Usage, Body);
}

// ── Feature / brand prefix ─────────────────────────────────────────────

export function Brand(Name: string, Body: string, Color: string = ChatColor.Brand): string {
  return `!{${Color}}${Name.toUpperCase()}:!{${ChatColor.White}} ${Body}`;
}

// ── Admin broadcast ────────────────────────────────────────────────────

export function Admin(Body: string): string {
  return `!{${ChatColor.Admin}}${Body}!{${ChatColor.White}}`;
}

// ── OOC wrap ───────────────────────────────────────────────────────────

/**
 * Mark a body string as Out-Of-Character with the unified `(( ))`
 * wrapper. Use for server narration (welcome lines, notice rows,
 * spawn-card labels) so the RP convention is clear at a glance. The
 * brackets default to white; the body keeps whatever colour tokens it
 * carries.
 */
export function OOC(Body: string): string {
  return `(( ${Body} ))`;
}

// ── Inline formatters ──────────────────────────────────────────────────

export function Money(Amount: number): string {
  const Rounded = Math.round(Amount);
  return `!{${ChatColor.Money}}$${Rounded.toLocaleString('en-US')}!{${ChatColor.White}}`;
}

export function Label(Name: string, Value: string): string {
  return `!{${ChatColor.Label}}${Name.toUpperCase()}:!{${ChatColor.White}} ${Value}`;
}

export function Cmd(Name: string): string {
  const Trimmed = Name.startsWith('/') ? Name : `/${Name}`;
  return `!{${ChatColor.Cmd}}${Trimmed}!{${ChatColor.White}}`;
}

export function Highlight(Text: string): string {
  return `!{${ChatColor.Highlight}}${Text}!{${ChatColor.White}}`;
}

// ── Block structure ────────────────────────────────────────────────────

function FrameWithTitle(Title: string, Color: string): string {
  // `=== [ TITLE ] ===` shape, centred to BlockWidth chars total of `=`
  // fill. No `|` end-caps - they read awkwardly in proportional fonts.
  // The bar fill AND the brackets colour with `Color`; only the title
  // text stays white so it pops against the frame.
  const Upper = Title.toUpperCase();
  // Six chars of fixed padding: ` [ ` + ` ] `.
  const Equals = BlockWidth - Upper.length - 6;
  const Left = Math.max(0, Math.floor(Equals / 2));
  const Right = Math.max(0, Equals - Left);
  return (
    `!{${Color}}${'='.repeat(Left)} [ ` +
    `!{${ChatColor.White}}${Upper}` +
    `!{${Color}} ] ${'='.repeat(Right)}` +
    `!{${ChatColor.White}}`
  );
}

export function Header(Title: string, Color: string = ChatColor.Header): string {
  return FrameWithTitle(Title, Color);
}

export function Section(Title: string, Color: string = ChatColor.Header): string {
  return FrameWithTitle(Title, Color);
}

export function Footer(Color: string = ChatColor.Header): string {
  return `!{${Color}}${'='.repeat(BlockWidth)}!{${ChatColor.White}}`;
}

export function Divider(Color: string = ChatColor.Header): string {
  return Footer(Color);
}

// ── IC/OOC chat lines ─────────────────────────────────────────────────
//
// Each helper builds one fully-formed token string ready to hand to the
// proximity broadcaster. Names arrive resolved (mask-aware) from the
// caller; these helpers do not look anything up.

/**
 * Apply a speech channel's full-line tint to an already-built text. /say
 * and /shout stay white; /low wraps in SpeechLow light gray; /whisper
 * wraps in SpeechQuiet pale orange.
 *
 * Exposed so directed-speech and any future channel-shaped formatter
 * can reuse the same per-channel tint policy without re-stating it.
 */
export function ApplyChannelTint(Text: string, Type: ChatType): string {
  switch (Type) {
    case 'Say':
    case 'Shout':
      return Text;
    case 'Low':
      return `!{${ChatColor.SpeechLow}}${Text}!{${ChatColor.White}}`;
    case 'Whisper':
      return `!{${ChatColor.SpeechQuiet}}${Text}!{${ChatColor.White}}`;
    case 'Ooc':
      return Text;
  }
}

/**
 * Speech line for /say, /shout, /whisper, /low. The text is
 * `<Name> <verb>: <Body>`, then the channel tint wraps the whole thing.
 */
export function Speech(Name: string, Body: string, Type: ChatType): string {
  return ApplyChannelTint(`${Name} ${ChatVerbs[Type]}: ${Body}`, Type);
}

/** `* <Name> <action>` rendered in RP purple. */
export function MeAction(Name: string, Action: string): string {
  return `!{${ChatColor.RP}}* ${Name} ${Action}!{${ChatColor.White}}`;
}

/** `* <description> (( <Name> )) *` rendered in RP purple. */
export function DoAction(Description: string, Name: string): string {
  return `!{${ChatColor.RP}}* ${Description} (( ${Name} )) *!{${ChatColor.White}}`;
}

/** `* <Name>'s <description>` rendered in RP purple. */
export function MyAction(Name: string, Description: string): string {
  return `!{${ChatColor.RP}}* ${Name}'s ${Description}!{${ChatColor.White}}`;
}

/** `(( <Name>: <body> ))` for /b local OOC, rendered in OOC blue. */
export function LocalOoc(Name: string, Body: string): string {
  return `!{${ChatColor.OOC}}(( ${Name}: ${Body} ))!{${ChatColor.White}}`;
}

/**
 * `(( PM to <Name>: <body> ))` shown to the sender after a /pm.
 *
 * Source ID deliberately not echoed. Name is the mask-aware DisplayName,
 * so a masked recipient appears as `Mask <MaskID>`. Pairing the Source ID
 * with a masked name would correlate the mask to its wearer across
 * encounters - exactly the metagame surface this slice guards against.
 */
export function PmTo(RecipientName: string, Body: string): string {
  return `!{${ChatColor.Highlight}}(( PM to ${RecipientName}: ${Body} ))!{${ChatColor.White}}`;
}

/** `(( PM from <Name>: <body> ))` shown to the recipient. Same metagame
 * reasoning as PmTo - no Source ID echoed. */
export function PmFrom(SenderName: string, Body: string): string {
  return `!{${ChatColor.Highlight}}(( PM from ${SenderName}: ${Body} ))!{${ChatColor.White}}`;
}
