import { ChatFormatter, type ChatType, ChatRanges } from '@Shared/Chat/Index.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { DebugEnabled, Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { ChatService } from '@/Services/ChatService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;
declare function Player(Source: number | string): { state: { [Key: string]: unknown } };
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * A sampled position plus the routing bucket it was in.
 *
 * The bucket is part of the identity, not extra detail: two players at
 * identical coordinates in different buckets are in different world
 * instances and must never hear each other, so any comparison that
 * ignores it is wrong.
 */
interface Snapshot {
  X: number;
  Y: number;
  Z: number;
  Bucket: number;
}

/**
 * Proximity-aware chat fan-out. Every IC speech / action / local OOC
 * command builds a token string and hands it to one of this service's
 * Broadcast* methods; the broadcaster handles the per-receiver position
 * read, routing-bucket filter, and Spawned-phase gate.
 *
 *   DisplayName(Source)   - mask-aware identity used by every formatter.
 *   BroadcastInRange      - generic core: pre-built Body string + radius.
 *   BroadcastSpeech       - convenience for /say/shout/whisper/low.
 *
 * Position reads stay EXACT. The validator's 2-second cache is still
 * refused - its ≤5m drift would be felt at the 3m whisper range, and it
 * stays in its anti-teleport lane. What the short-lived cache below does
 * instead is prune: an entry is only ever trusted to rule a receiver
 * OUT, and only when they are further away than they could possibly
 * have travelled since the sample. Anyone who might be in range is read
 * fresh, so every delivered line is decided on a live coordinate. The
 * saving is the far field, which on a city-sized map is nearly everyone.
 *
 * Routing-bucket equality is enforced as part of range - players in
 * different worlds never hear each other regardless of geometry.
 */

/**
 * How long a pruning sample stays usable. Short, because the drift
 * budget it buys grows with it.
 */
const PruneCacheTtlMs = 250;

/**
 * Upper bound on how fast anything in the world can move, in m/s, used
 * to convert a sample's age into a distance the player might have
 * covered since. Deliberately generous - a jet at full tilt sits under
 * this - because the bound only has to be an over-estimate to keep the
 * prune sound. Over-estimating costs a fresh read; under-estimating
 * would silently drop a line someone should have heard.
 */
const MaxPlausibleSpeedMs = 120;

/**
 * Range-filtered chat fan-out, and the single chokepoint for mask-aware
 * naming. Every channel that names a character resolves it through
 * DisplayName here, which is what guarantees a masked character cannot
 * leak their legal name through any one command that forgot to check.
 *
 * Positions come from a short-lived sample cache rather than a native
 * read per receiver; MaxPlausibleSpeedMs above governs when a cached
 * sample is too old to trust.
 */
export class ProximityBroadcaster {
  private readonly Log = Logger.New('Proximity');
  /** Source -> last sampled position + the wall clock at sampling. */
  private readonly PruneCache = new Map<number, Snapshot & { AtMs: number }>();

  constructor(
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Chat: ChatService,
  ) {}

  /**
   * Per-Source eviction - invoked by the PlayerSessionService
   * playerDropped dispatcher. Without it a recycled netId could inherit
   * the previous occupant's sample and be pruned out of a broadcast
   * they were actually standing in.
   */
  Evict(Source: number): void {
    this.PruneCache.delete(Source);
  }

  /**
   * Resolve a source's chat-displayed identity. Returns the legal name
   * when unmasked, `Stranger <MaskID>` when masked. Returns null when the
   * runtime is not attached (player not spawned, or detached mid-flow).
   *
   * This is the single chokepoint for the anti-metagame rule: every
   * IC-channel formatter calls through here, so a masked character never
   * leaks their legal name into chat regardless of which command produced
   * the line. The `Stranger` framing is in-fiction (an observer who does
   * not recognise the masked person) rather than the meta `Mask` label.
   */
  DisplayName(Source: number): string | null {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return null;
    if (Runtime.IsMasked) return `Stranger ${Runtime.MaskID}`;
    return `${Runtime.FirstName} ${Runtime.LastName}`;
  }

  /**
   * Broadcast `Body` (a fully-formed token string) to every Spawned
   * receiver within `Range` metres of `Sender` in the same routing
   * bucket. The sender is included in the iteration so their own line
   * mirrors back to them; no special-case required.
   *
   * `ExcludeReceiver` skips one Source by netId without affecting the
   * range / bucket / phase filters. Used by directed speech so the
   * target does not see the third-person bystander line on top of
   * the marker-prefixed copy.
   *
   * Returns the number of receivers the line landed on. 0 means the
   * sender either had no resolvable ped or no one else was in range -
   * either way, nothing to surface to the player (the broadcast is
   * silent by design).
   */
  BroadcastInRange(
    Sender: number,
    Body: string,
    Range: number,
    ExcludeReceiver?: number,
  ): number {
    // The sender is always sampled live - one read, and it anchors every
    // comparison below.
    const Origin = this.Snapshot(Sender);
    if (Origin === null) return 0;
    const RangeSq = Range * Range;
    const NowMs = Date.now();

    let Count = 0;
    for (const Receiver of this.State.GetSpawnedSources()) {
      if (Receiver === ExcludeReceiver) continue;
      if (this.PrunableByCache(Receiver, Origin, Range, NowMs)) continue;
      const Spot = this.Snapshot(Receiver);
      if (Spot === null) continue;
      if (Spot.Bucket !== Origin.Bucket) continue;

      const Dx = Spot.X - Origin.X;
      const Dy = Spot.Y - Origin.Y;
      const Dz = Spot.Z - Origin.Z;
      if (Dx * Dx + Dy * Dy + Dz * Dz > RangeSq) continue;

      // Per-viewer server-ID prefix: each receiver who has the
      // nametag-ID toggle on sees the speaker's server ID lead the
      // line, mirroring the `(id)` nametag suffix. Gated by the
      // receiver's own preference (not the sender's), so formatting
      // is necessarily per-recipient here rather than one shared line.
      const Line = this.WantsServerIds(Receiver)
        ? ChatFormatter.ServerIdPrefix(Sender) + Body
        : Body;
      this.Chat.SendTo(Receiver, Line);
      Count += 1;
    }

    // Guarded: this runs on every IC line, action and local-OOC message.
    // The level check inside Emit happens after the template has already
    // been interpolated, so in production (log_level=warn) that string
    // was being built and thrown away for every broadcast.
    if (DebugEnabled()) {
      this.Log.Debug(`BroadcastInRange src=${Sender} range=${Range} reached=${Count}`);
    }
    return Count;
  }

  /**
   * True when a cached sample proves `Receiver` is out of range, so the
   * live read can be skipped entirely.
   *
   * Sound because it only ever answers "definitely out". A sample taken
   * `Age` ms ago bounds how far its subject can have moved since at
   * `MaxPlausibleSpeedMs`; only when the cached distance exceeds the
   * range PLUS that whole travel budget is the receiver ruled out. Any
   * receiver who could conceivably be in range - and every receiver in a
   * different routing bucket, since buckets can change without moving -
   * falls through to the exact read.
   *
   * Returns false whenever there is no usable sample, so a cold cache
   * behaves exactly like the previous read-everyone loop.
   */
  private PrunableByCache(
    Receiver: number,
    Origin: Snapshot,
    Range: number,
    NowMs: number,
  ): boolean {
    const Cached = this.PruneCache.get(Receiver);
    if (Cached === undefined) return false;
    const Age = NowMs - Cached.AtMs;
    if (Age < 0 || Age > PruneCacheTtlMs) return false;
    if (Cached.Bucket !== Origin.Bucket) return false;
    const Dx = Cached.X - Origin.X;
    const Dy = Cached.Y - Origin.Y;
    const Dz = Cached.Z - Origin.Z;
    const Distance = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
    const TravelBudget = (Age / 1000) * MaxPlausibleSpeedMs;
    return Distance > Range + TravelBudget;
  }

  /**
   * Whether `Viewer` wants to see server IDs - the same preference that
   * drives the nametag `(id)` suffix, read from the replicated
   * NametagIDVisible state bag. Defaults to true (the catalog default)
   * when the bag is unset, matching the nametag renderer's own default,
   * so chat IDs and nametag IDs always agree. Server-readable with no DB
   * hit, so it is cheap enough for the per-receiver broadcast loop.
   */
  WantsServerIds(Viewer: number): boolean {
    try {
      return Player(String(Viewer)).state[NametagBagKeys.IDVisible] !== false;
    } catch {
      return true;
    }
  }

  /**
   * Convenience wrapper: build a speech line via ChatFormatter.Speech and
   * broadcast at the channel's standard range. Names resolve through
   * DisplayName so masked characters never leak. Returns receiver count
   * for logging at the call site.
   */
  BroadcastSpeech(Sender: number, Body: string, Type: ChatType): number {
    const Name = this.DisplayName(Sender);
    if (Name === null) return 0;
    const Line = ChatFormatter.Speech(Name, Body, Type);
    return this.BroadcastInRange(Sender, Line, ChatRanges[Type]);
  }

  /**
   * One native triple: world coords + routing bucket. Returns null when
   * the player has no ped resolvable (model not loaded yet, or already
   * detached). Caller treats null as "nothing to broadcast".
   */
  private Snapshot(Source: number): Snapshot | null {
    try {
      const SrcStr = String(Source);
      const Ped = GetPlayerPed(SrcStr);
      if (Ped === 0) return null;
      const Coords = GetEntityCoords(Ped);
      const X = Number(Coords[0]);
      const Y = Number(Coords[1]);
      const Z = Number(Coords[2]);
      if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) {
        return null;
      }
      const Bucket = Number(GetPlayerRoutingBucket(SrcStr));
      const Result: Snapshot = { X, Y, Z, Bucket: Number.isFinite(Bucket) ? Bucket : 0 };
      // Every live read feeds the prune cache, so the next broadcast
      // inside the TTL can rule this player out without reading again.
      // Receivers pruned by that cache are NOT refreshed here, so their
      // entry ages out and they are re-sampled - a player is read at
      // most once per TTL plus once per message they are actually near.
      this.PruneCache.set(Source, { ...Result, AtMs: Date.now() });
      return Result;
    } catch (Err: unknown) {
      this.Log.Warn(`Snapshot failed source=${Source}`, { Err: String(Err) });
      return null;
    }
  }
}
