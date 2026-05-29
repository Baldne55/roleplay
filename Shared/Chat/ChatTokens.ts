import { ChatColor } from './ChatPalette.js';

/**
 * A token-parsed run of chat text in a single colour. The UI renders
 * Segments as a v-for over <span :style="{ color }">, never v-html.
 */
export interface ChatSegment {
  Text: string;
  Color: string;
}

/**
 * Matches a `!{#RRGGBB}` colour token. Six hex digits, case-insensitive.
 * Anchored on a literal `!{#` and `}` so legitimate text containing `#`
 * doesn't get pulled in.
 */
const TokenPattern = /!\{#([0-9a-fA-F]{6})\}/g;

/**
 * Parse a server-emitted token string into a list of coloured runs.
 *
 *   Parse('!{#88AAFF}INFO:!{#FFFFFF} body')
 *     -> [{Text:'INFO:', Color:'#88AAFF'}, {Text:' body', Color:'#FFFFFF'}]
 *
 * Text before the first token defaults to the white reset colour, matching
 * the format spec - every colour run is expected to end with `!{#FFFFFF}`
 * so trailing brackets / body render white.
 */
export function Parse(Text: string): ChatSegment[] {
  if (Text.length === 0) return [];

  const Segments: ChatSegment[] = [];
  let Current: string = ChatColor.White;
  let Cursor = 0;

  TokenPattern.lastIndex = 0;
  let Match: RegExpExecArray | null = null;
  while ((Match = TokenPattern.exec(Text)) !== null) {
    if (Match.index > Cursor) {
      Segments.push({ Text: Text.slice(Cursor, Match.index), Color: Current });
    }
    const Hex = Match[1] ?? '';
    Current = `#${Hex.toUpperCase()}`;
    Cursor = Match.index + Match[0].length;
  }

  if (Cursor < Text.length) {
    Segments.push({ Text: Text.slice(Cursor), Color: Current });
  }

  return Segments;
}

/**
 * Strip colour tokens from untrusted player-supplied content. Used by the
 * Backend chat controller before treating a submitted line as text -
 * without this a player could inject `!{#FF8080}fake admin alert` and
 * render whatever colour they please.
 */
export function Sanitize(Untrusted: string): string {
  return Untrusted.replace(TokenPattern, '');
}
