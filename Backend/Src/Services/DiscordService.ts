import { request as HttpsRequest } from 'node:https';
import { URL } from 'node:url';
import { Logger } from '@/Util/Logger.js';
import type { ServerConfig } from '@/Infrastructure/Config/ServerConfig.js';

/*
 * Discord REST endpoints, pinned to API v10. Built as functions rather
 * than string concatenation at the call site so the version prefix lives
 * in exactly one place when Discord deprecates it.
 */

/** Profile lookup. Returns the public user object for any snowflake. */
const UserEndpoint = (ID: string): string => `https://discord.com/api/v10/users/${ID}`;
/** Guild membership probe - 200 means in the guild, 404 means not. */
const GuildMemberEndpoint = (GuildID: string, UserID: string): string =>
  `https://discord.com/api/v10/guilds/${GuildID}/members/${UserID}`;
/** CDN base for avatar images; the hash and extension are appended by AvatarURL. */
const AvatarCDN = 'https://cdn.discordapp.com/avatars';

/** Subset of `/users/{id}` we care about. Email is not returned for bot-token requests. */
export interface DiscordProfile {
  ID: string;
  Username: string;
  /** Display name (the user-visible label). Falls back to Username when absent. */
  DisplayName: string;
  /** Avatar hash, or null when the user has the default avatar. */
  AvatarHash: string | null;
}

/**
 * Discord REST API wrapper using a bot token (NOT OAuth).
 *
 *   FetchProfile(id)             -> GET /users/{id}
 *   IsGuildMember(guildId, id)   -> GET /guilds/{guildId}/members/{id} -> 200=in, 404=out
 *
 * Auth header: `Bot <token>`. The bot needs no scopes / permissions
 * beyond being IN the configured guild (so the guild-members endpoint
 * doesn't 403). Add the bot via the OAuth2 URL generator in the Discord
 * dev portal with `bot` scope, no permissions checked.
 *
 * No OAuth code path here - registration + sign-in are unified into a
 * single bot-driven identity resolution that runs on playerJoining.
 */
export class DiscordService {
  private readonly Log = Logger.New('Discord');

  constructor(private readonly Config: ServerConfig) {}

  /**
   * Fetch a Discord user's display name and avatar for the sign-in card.
   *
   * Cosmetic only - identity is already established from the FiveM
   * identifier before this runs, so a failure degrades the greeting
   * rather than blocking the connection.
   */
  async FetchProfile(DiscordID: string): Promise<DiscordProfile> {
    const Response = await HttpGet(UserEndpoint(DiscordID), this.AuthHeaders());
    if (Response.Status !== 200) {
      throw new Error(`Discord /users/${DiscordID} returned ${Response.Status}: ${Response.Body.slice(0, 200)}`);
    }
    const Parsed = SafeJSONParse(Response.Body);
    if (Parsed === null || typeof Parsed !== 'object') {
      throw new Error(`Discord /users/${DiscordID} returned non-JSON`);
    }
    /* eslint-disable @typescript-eslint/naming-convention -- Discord API wire format: field names fixed by Discord */
    const Raw = Parsed as {
      id?: unknown;
      username?: unknown;
      global_name?: unknown;
      avatar?: unknown;
    };
    /* eslint-enable @typescript-eslint/naming-convention */
    if (typeof Raw.id !== 'string' || typeof Raw.username !== 'string') {
      throw new Error(`Discord /users/${DiscordID} missing required fields`);
    }
    const Profile: DiscordProfile = {
      ID: Raw.id,
      Username: Raw.username,
      DisplayName: typeof Raw.global_name === 'string' && Raw.global_name.length > 0 ? Raw.global_name : Raw.username,
      AvatarHash: typeof Raw.avatar === 'string' ? Raw.avatar : null,
    };
    this.Log.Debug(`Fetched profile id=${Profile.ID} display="${Profile.DisplayName}"`);
    return Profile;
  }

  /**
   * Whether the user is in the configured guild - the whitelist gate,
   * unlike FetchProfile.
   *
   * Because a false here refuses a connection, the failure mode matters:
   * an API outage must not lock the whole playerbase out, so callers
   * decide the fallback rather than having it decided here.
   */
  async IsGuildMember(DiscordID: string): Promise<boolean> {
    const Response = await HttpGet(GuildMemberEndpoint(this.Config.DiscordGuildID, DiscordID), this.AuthHeaders());
    if (Response.Status === 200) return true;
    if (Response.Status === 404) return false;
    if (Response.Status === 403) {
      throw new Error(
        `Discord guild member check 403: the bot is not in guild ${this.Config.DiscordGuildID}. Invite it first.`,
      );
    }
    throw new Error(`Discord guild member check returned ${Response.Status}: ${Response.Body.slice(0, 200)}`);
  }

  /** Helper for the UI: full CDN URL for the avatar (PNG, 256px), or null. */
  AvatarURL(Profile: Pick<DiscordProfile, 'ID' | 'AvatarHash'>): string | null {
    if (Profile.AvatarHash === null) return null;
    return `${AvatarCDN}/${Profile.ID}/${Profile.AvatarHash}.png?size=256`;
  }

  /** Bot-token authorisation headers for the Discord API. */
  private AuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bot ${this.Config.DiscordBotToken}`,
      Accept: 'application/json',
      'User-Agent': 'Roleplay (FXServer, v0.1)',
    };
  }
}

// ── HTTPS helper (node:https; FXServer's bundled Node lacks global fetch) ──

/** Raw HTTP result - body left unparsed so the caller decides how to read it. */
interface HttpResponse {
  Status: number;
  Body: string;
}

/**
 * Minimal promise-wrapped HTTPS GET over Node's `https` module.
 *
 * Hand-rolled rather than using a client library because this runs inside
 * the FXServer Node runtime, where adding a dependency for one call to
 * the Discord API is not worth the bundle. Resolves on any status - a 401
 * or 429 is a normal outcome the caller inspects, not a rejection.
 */
function HttpGet(Url: string, Headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((Resolve, Reject) => {
    const Parsed = new URL(Url);
    const Req = HttpsRequest(
      {
        method: 'GET',
        hostname: Parsed.hostname,
        port: Parsed.port || 443,
        path: `${Parsed.pathname}${Parsed.search}`,
        headers: Headers,
      },
      (Res) => {
        const Chunks: Buffer[] = [];
        Res.on('data', (Chunk: Buffer) => Chunks.push(Chunk));
        Res.on('end', () => {
          Resolve({ Status: Res.statusCode ?? 0, Body: Buffer.concat(Chunks).toString('utf8') });
        });
        Res.on('error', Reject);
      },
    );
    Req.on('error', Reject);
    Req.end();
  });
}

/**
 * Parse a response body, yielding null instead of throwing. Discord can
 * answer with an HTML error page rather than JSON, which must degrade to
 * "no profile" rather than taking down the connection handler.
 */
function SafeJSONParse(Raw: string): unknown {
  try {
    return JSON.parse(Raw);
  } catch {
    return null;
  }
}
