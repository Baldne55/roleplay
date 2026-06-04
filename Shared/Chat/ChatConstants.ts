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
export type ChatType = 'Say' | 'Shout' | 'Whisper' | 'Low' | 'Ooc';

export const ChatRanges: Record<ChatType, number> = {
  Say: 10,
  Shout: 25,
  Whisper: 3,
  Low: 5,
  Ooc: 15,
};

export const ChatVerbs: Record<ChatType, string> = {
  Say: 'says',
  Shout: 'shouts',
  Whisper: 'whispers',
  Low: 'says quietly',
  Ooc: '',
};
