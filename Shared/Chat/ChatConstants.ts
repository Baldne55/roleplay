/**
 * Shared constants for the IC/OOC chat command surface.
 *
 *   - ChatType discriminates the speech channels (and the local OOC wrap
 *     that piggybacks the same range mechanic).
 *   - ChatRanges holds the metres-distance for proximity filtering. Used
 *     by SpeechCommands directly and by RoleplayActionCommands which map
 *     /me /do /my variants onto the same Say / Low / Shout brackets.
 *   - ChatVerbs is the inline word the speech formatter inserts between
 *     <Name> and ': <body>'. /b uses its own (( wrap and has no verb.
 *
 * Tint decisions live in ChatFormatter.Speech, not here - /say and
 * /shout render fully white, /low and /whisper carry a full-line tint
 * across name + verb + body. See ChatFormatter for the per-channel
 * branches.
 */
/**
 * Longest chat line a player may submit, in characters.
 *
 * Shared deliberately: the UI enforces it on the input (`maxlength` plus
 * a paste truncation) and the Backend re-checks it on arrival, and the
 * two must not drift. They were independent literals in two workspaces -
 * raise one alone and players either get silently truncated input or a
 * rejection for a line the box let them type.
 *
 * The Backend measures AFTER Sanitize + trim, so its check can only ever
 * be more permissive than the box; the client bound is the real ceiling.
 */
export const ChatBodyMaxLength = 240;

/** Speech channel. Determines both proximity range and the line's colour tint. */
export type ChatType = 'Say' | 'Shout' | 'Whisper' | 'Low' | 'Ooc';

/**
 * Audible radius per channel, in metres. The single source of truth for
 * proximity - commands reference `ChatRanges[Type]` rather than repeating
 * a literal, so the ranges quoted in every command's Description and the
 * ranges actually broadcast cannot drift apart.
 *
 * Ooc is 15 rather than Say's 10 on purpose: an out-of-character aside
 * should reach the whole scene a player is part of, including anyone just
 * outside speaking distance.
 */
export const ChatRanges: Record<ChatType, number> = {
  Say: 10,
  Shout: 25,
  Whisper: 3,
  Low: 5,
  Ooc: 15,
};

/**
 * Third-person verb inserted between speaker and body ("Name says: ...").
 * Ooc is deliberately empty - OOC lines render through the bracket
 * formatter, which supplies its own framing and never uses a verb.
 */
export const ChatVerbs: Record<ChatType, string> = {
  Say: 'says',
  Shout: 'shouts',
  Whisper: 'whispers',
  Low: 'says quietly',
  Ooc: '',
};
