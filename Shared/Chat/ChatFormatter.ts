import { ChatColor } from './ChatPalette.js';
import { ChatVerbs, type ChatType } from './ChatConstants.js';
import { Sanitize } from './ChatTokens.js';

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

/**
 * Shared shape for the four severity wraps: a coloured ALL-CAPS tag
 * inside the `(( ))` OOC brackets.
 *
 * Every severity line is OOC-wrapped because all four are the server
 * talking to the player, never a character speaking - the brackets are
 * what keeps system feedback visually outside the roleplay.
 */
function Severity(Tag: string, Color: string, Body: string): string {
  return `(( !{${Color}}${Tag}:!{${ChatColor.White}} ${Body} ))`;
}

/** Something failed. Reserved for actual faults, not refusals a player caused. */
export function Error(Body: string): string {
  return Severity('ERROR', ChatColor.Error, Body);
}

/** Something worked but deserves attention, or is about to stop working. */
export function Warning(Body: string): string {
  return Severity('WARNING', ChatColor.Warning, Body);
}

/** Neutral confirmation - the default for "your command did the thing". */
export function Info(Body: string): string {
  return Severity('INFO', ChatColor.Info, Body);
}

/** Syntax help after a malformed command. Body is the usage signature. */
export function Usage(Body: string): string {
  return Severity('USAGE', ChatColor.Usage, Body);
}

// ── Feature / brand prefix ─────────────────────────────────────────────

/**
 * Prefix a line with a feature name - `RADIO:`, `PHONE:`, `ADMIN:`.
 *
 * Not OOC-wrapped, unlike the severity helpers: a branded line is usually
 * an in-world system speaking (a radio, a phone) rather than the server
 * addressing the player, so it stays inside the fiction. The optional
 * colour lets a subsystem own its own hue.
 */
export function Brand(Name: string, Body: string, Color: string = ChatColor.Brand): string {
  return `!{${Color}}${Name.toUpperCase()}:!{${ChatColor.White}} ${Body}`;
}

// ── Admin broadcast ────────────────────────────────────────────────────

/**
 * Tint an entire line in the admin colour. Unlike Brand there is no tag -
 * the colour alone is the signal, so the body should say who is speaking.
 */
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

/**
 * Render a whole-dollar amount with thousands separators.
 *
 * Takes dollars, not cents, and rounds - so it is the wrong helper for
 * exact currency. Money that must balance goes through
 * `FormatCashCents` in the inventory constants instead; this one is for
 * display figures where a rounded number reads better.
 */
export function Money(Amount: number): string {
  const Rounded = Math.round(Amount);
  return `!{${ChatColor.Money}}$${Rounded.toLocaleString('en-US')}!{${ChatColor.White}}`;
}

/**
 * `NAME: value` - the workhorse for every detail line in a framed block.
 * The name is upper-cased per the caps rule; the value is passed through
 * untouched so it can carry its own colour tokens.
 */
export function Label(Name: string, Value: string): string {
  return `!{${ChatColor.Label}}${Name.toUpperCase()}:!{${ChatColor.White}} ${Value}`;
}

/**
 * Render a command reference, adding the leading slash if the caller
 * omitted it, so `Cmd('help')` and `Cmd('/help')` produce the same line.
 */
export function Cmd(Name: string): string {
  const Trimmed = Name.startsWith('/') ? Name : `/${Name}`;
  return `!{${ChatColor.Cmd}}${Trimmed}!{${ChatColor.White}}`;
}

/** Emphasise a fragment mid-sentence - a name, a number, a target. */
export function Highlight(Text: string): string {
  return `!{${ChatColor.Highlight}}${Text}!{${ChatColor.White}}`;
}

// ── Block structure ────────────────────────────────────────────────────

/**
 * Build a centred `=== [ TITLE ] ===` bar padded to BlockWidth.
 *
 * Shared by Header and Section. A title longer than the available width
 * clamps the fill to zero rather than producing a negative repeat count,
 * so an over-long title degrades to `[ TITLE ]` instead of throwing.
 */
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

/**
 * Open a framed block. Pair with a Footer - a block left unclosed runs
 * into whatever chat line arrives next.
 */
export function Header(Title: string, Color: string = ChatColor.Header): string {
  return FrameWithTitle(Title, Color);
}

/**
 * Titled divider inside an open block. Identical output to Header today;
 * the two names exist so intent stays readable at the call site and the
 * shapes can diverge later without touching callers.
 */
export function Section(Title: string, Color: string = ChatColor.Header): string {
  return FrameWithTitle(Title, Color);
}

/** Close a framed block with a plain full-width bar. */
export function Footer(Color: string = ChatColor.Header): string {
  return `!{${Color}}${'='.repeat(BlockWidth)}!{${ChatColor.White}}`;
}

/**
 * Untitled separator between groups inside a block. Same output as
 * Footer - see Section for why the alias exists.
 */
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

/**
 * Leading `(<id>) ` server-ID token, tinted OOC grey so it reads as the
 * out-of-character handle it is (the same server ID the nametag shows),
 * fading against the line rather than competing with the IC content.
 * Prepended per-recipient to speech / action / PM lines when the viewer
 * has the nametag-ID toggle on - the chat counterpart of the `(id)`
 * nametag suffix, gated by the same preference.
 */
export function ServerIdPrefix(Id: number): string {
  return `!{${ChatColor.OOC}}(${Id}) !{${ChatColor.White}}`;
}

/**
 * Handheld-radio transmission line, tinted cyan across the whole
 * utterance so radio traffic reads as its own channel. `Frequency` is
 * the channel the sender keyed; `Name` arrives mask-aware from the
 * caller (a masked sender is `Stranger <MaskID>`, so the radio never
 * leaks an identity the voice wouldn't). The optional server-ID prefix,
 * when shown, is prepended per-viewer at the call site via
 * ServerIdPrefix, not baked in here.
 */
export function RadioTransmission(Frequency: number, Name: string, Body: string): string {
  return `!{${ChatColor.Radio}}[RADIO ${Frequency}] ${Name}: ${Body}!{${ChatColor.White}}`;
}

/**
 * Phone SMS line shown to the recipient, tinted indigo across the whole
 * utterance so phone traffic reads as its own channel. `Sender` is the
 * recipient's saved contact name for the originating number, else the raw
 * number - NEVER the legal name, so an incoming text cannot leak the
 * sender's identity. Body and sender are re-sanitised here as defence in
 * depth: phone text is persisted and replayed later, so a colour token
 * must never survive into a rendered line however it was stored. No
 * server-ID prefix is ever prepended (unlike radio) - that OOC handle
 * would de-anonymise the phone identity.
 */
export function PhoneSms(Sender: string, Body: string): string {
  return `!{${ChatColor.Phone}}[SMS] ${Sanitize(Sender)}: ${Sanitize(Body)}!{${ChatColor.White}}`;
}

/** Voicemail line shown when a stored voicemail is read. Identity + body
 * resolved and sanitised exactly as PhoneSms. */
export function PhoneVoicemail(Sender: string, Body: string): string {
  return `!{${ChatColor.Phone}}[VOICEMAIL] ${Sanitize(Sender)}: ${Sanitize(Body)}!{${ChatColor.White}}`;
}

/** Over-the-line speech relayed to the remote party on a live call. The
 * `Sender` is the peer's contact name for the number, else the number -
 * never the legal name (the remote party cannot metagame the caller).
 * Identity + body sanitised, no server-ID prefix, exactly as PhoneSms. */
export function PhoneCallSpeech(Sender: string, Body: string): string {
  return `!{${ChatColor.Phone}}[PHONE] ${Sanitize(Sender)}: ${Sanitize(Body)}!{${ChatColor.White}}`;
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
 * `(( PM to <Name>: <body> ))` shown to the sender after a /pm. Name is
 * the mask-aware DisplayName (a masked recipient appears as
 * `Stranger <MaskID>`). The OOC server-ID prefix, when shown, is added
 * per-viewer at the call site via ServerIdPrefix (gated by the viewer's
 * nametag-ID toggle), not baked in here.
 */
export function PmTo(RecipientName: string, Body: string): string {
  return `!{${ChatColor.Highlight}}(( PM to ${RecipientName}: ${Body} ))!{${ChatColor.White}}`;
}

/** `(( PM from <Name>: <body> ))` shown to the recipient. Mask-aware
 * name; the optional server-ID prefix is applied per-viewer at the call
 * site (see PmTo). */
/**
 * Incoming private message, OOC-wrapped because a PM is player-to-player
 * rather than character-to-character.
 */
export function PmFrom(SenderName: string, Body: string): string {
  return `!{${ChatColor.Highlight}}(( PM from ${SenderName}: ${Body} ))!{${ChatColor.White}}`;
}
