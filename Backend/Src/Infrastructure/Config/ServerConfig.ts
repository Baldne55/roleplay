/**
 * Server config - read from FXServer convars at boot.
 *
 * Mirrors lc-rp's `ServerConfig.Load()` pattern. Every consumer reads from
 * this typed shape, never from `GetConvar` directly, so the convar contract
 * is documented in one place.
 *
 * Convars never cross to the client (no `setr` here). See server.cfg for the
 * full list of expected keys.
 */
import { z } from 'zod';

/**
 * The convar contract, validated at boot. Parsing here rather than at each
 * consumer means a misconfigured server fails immediately with a named
 * field instead of surfacing as an undefined deep in a request path.
 *
 * `z.coerce` on the numeric fields is required, not stylistic: GetConvar
 * always returns a string, so a plain z.number() would reject every value.
 */
const RawSchema = z.object({
  DBHost: z.string().min(1),
  DBPort: z.coerce.number().int().positive(),
  DBUser: z.string().min(1),
  DBPassword: z.string(),
  DBName: z.string().min(1),

  // Discord identity gate - bot token + guild gating. Auth runs entirely
  // through Discord's IPC identifier (no OAuth dance); the bot token lets
  // us call /users/{id} and /guilds/{guild_id}/members/{user_id}.
  DiscordBotToken: z.string().min(1),
  DiscordGuildID: z.string().regex(/^\d+$/, 'must be a Discord snowflake'),
  DiscordGuildInvite: z.string().min(1),

  // User Control Panel URL. Surfaced to Pending accounts (kicked at join)
  // so they know where to take the roleplay quiz that flips them to Active.
  UCPUrl: z.string().min(1),

  // Anti-cheat pipeline. Webhook empty = Discord alerts disabled (in-game
  // staff alerts always fire). Enforcement `observe` logs + alerts only;
  // `kick` additionally drops players past a detection's kick threshold.
  AnticheatDiscordWebhook: z.string(),
  AnticheatEnforcement: z.enum(['observe', 'kick']),
});

/** Validated server config, inferred from the zod schema so the two cannot drift. */
export type ServerConfig = z.infer<typeof RawSchema>;

declare function GetConvar(VarName: string, Default: string): string;

/**
 * Read every convar the server needs and validate them as one object.
 *
 * Zod-parsed rather than read ad hoc so a missing or malformed setting
 * fails loudly at boot instead of surfacing as an undefined deep inside a
 * request. Convars are strings, so the schema also does the numeric and
 * enum coercion - `anticheat_enforcement` in particular must be one of
 * `observe` | `kick`, defaulting to `observe`.
 */
export function LoadServerConfig(): ServerConfig {
  const Raw = {
    DBHost: GetConvar('db_host', 'localhost'),
    DBPort: GetConvar('db_port', '3306'),
    DBUser: GetConvar('db_user', 'root'),
    DBPassword: GetConvar('db_password', ''),
    DBName: GetConvar('db_name', 'roleplay'),
    DiscordBotToken: GetConvar('discord_bot_token', ''),
    DiscordGuildID: GetConvar('discord_guild_id', ''),
    DiscordGuildInvite: GetConvar('discord_guild_invite', ''),
    UCPUrl: GetConvar('ucp_url', ''),
    AnticheatDiscordWebhook: GetConvar('anticheat_discord_webhook', ''),
    AnticheatEnforcement: GetConvar('anticheat_enforcement', 'observe'),
  };
  const Result = RawSchema.safeParse(Raw);
  if (!Result.success) {
    throw new Error(`Invalid server.cfg convars: ${Result.error.message}`);
  }
  return Result.data;
}
