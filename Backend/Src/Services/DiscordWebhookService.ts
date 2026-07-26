import { request as HttpsRequest } from 'node:https';
import { URL } from 'node:url';
import { Logger } from '@/Util/Logger.js';
import type { ServerConfig } from '@/Infrastructure/Config/ServerConfig.js';

/**
 * Minimal Discord webhook poster. Separate from DiscordService on
 * purpose - that wrapper is bot-token identity resolution (REST GETs
 * with auth headers); this one POSTs unauthenticated webhook payloads
 * to whatever channel the webhook URL was minted for.
 *
 * Sole consumer today is the anti-cheat alert pipeline. Disabled when
 * the `anticheat_discord_webhook` convar is empty - PostAlert becomes
 * a no-op so call sites never need to branch.
 *
 * Fire-and-forget semantics: a webhook outage must never stall or
 * throw into a detection path, so failures log a warning and stop.
 */
export class DiscordWebhookService {
  private readonly Log = Logger.New('DiscordWebhook');

  constructor(private readonly Config: ServerConfig) {}

  /**
   * Whether a webhook URL is configured. Callers check this rather than
   * relying on PostAlert no-opping, so they can skip building the payload
   * entirely when alerting is off.
   */
  get Enabled(): boolean {
    return this.Config.AnticheatDiscordWebhook.length > 0;
  }

  /**
   * Post a staff alert to the configured webhook.
   *
   * Never throws and never blocks the caller: this runs off the
   * anti-cheat detection path, where a Discord outage or rate limit must
   * not interfere with scoring or enforcement. No-ops when disabled.
   */
  async PostAlert(Title: string, Lines: string[]): Promise<void> {
    if (!this.Enabled) return;
    // Wire-format keys (embeds/title/description/color) are fixed by
    // Discord; object literals in expression position pass the naming
    // rule as-is.
    const Payload = JSON.stringify({
      embeds: [
        {
          title: Title,
          description: Lines.join('\n').slice(0, 4000),
          color: 0xe74c3c,
        },
      ],
    });
    try {
      const Status = await HttpPostJSON(this.Config.AnticheatDiscordWebhook, Payload);
      if (Status !== 204 && Status !== 200) {
        this.Log.Warn(`Webhook post returned ${Status}`);
      }
    } catch (Err: unknown) {
      this.Log.Warn('Webhook post failed', { Err: String(Err) });
    }
  }
}

// ── HTTPS helper (node:https; FXServer's bundled Node lacks global fetch) ──

/**
 * Fire a JSON POST at a webhook and resolve with the status code.
 *
 * Resolves rather than rejects on an error status: a webhook is a
 * best-effort side channel, and a 404 from a rotated URL or a 429 from
 * Discord's rate limiter must never propagate into the anti-cheat path
 * that called it. The caller logs the code and moves on.
 */
function HttpPostJSON(Url: string, Body: string): Promise<number> {
  return new Promise((Resolve, Reject) => {
    const Parsed = new URL(Url);
    const Req = HttpsRequest(
      {
        method: 'POST',
        hostname: Parsed.hostname,
        port: Parsed.port || 443,
        path: `${Parsed.pathname}${Parsed.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(Body),
        },
      },
      (Res) => {
        // Drain the response so the socket frees; only the status matters.
        Res.on('data', () => undefined);
        Res.on('end', () => Resolve(Res.statusCode ?? 0));
        Res.on('error', Reject);
      },
    );
    Req.on('error', Reject);
    Req.write(Body);
    Req.end();
  });
}
