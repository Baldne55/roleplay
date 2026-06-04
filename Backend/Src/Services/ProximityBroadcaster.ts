import { ChatFormatter, type ChatType, ChatRanges } from '@Shared/Chat/Index.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { ChatService } from '@/Services/ChatService.js';

declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;

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
 * Position reads are live native calls per broadcast - NOT the
 * PositionValidatorService cache. The validator runs a 2-second tick;
 * the resulting ≤5m drift would be felt at the 3m whisper range. Chat
 * submissions are rare enough that the native cost is negligible, and
 * the validator stays in its anti-teleport lane.
 *
 * Routing-bucket equality is enforced as part of range - players in
 * different worlds never hear each other regardless of geometry.
 */
export class ProximityBroadcaster {
  private readonly Log = Logger.New('Proximity');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Chat: ChatService,
  ) {}

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
    const Origin = this.Snapshot(Sender);
    if (Origin === null) return 0;
    const RangeSq = Range * Range;

    let Count = 0;
    for (const Receiver of this.State.GetSpawnedSources()) {
      if (Receiver === ExcludeReceiver) continue;
      const Spot = this.Snapshot(Receiver);
      if (Spot === null) continue;
      if (Spot.Bucket !== Origin.Bucket) continue;

      const Dx = Spot.X - Origin.X;
      const Dy = Spot.Y - Origin.Y;
      const Dz = Spot.Z - Origin.Z;
      if (Dx * Dx + Dy * Dy + Dz * Dz > RangeSq) continue;

      this.Chat.SendTo(Receiver, Body);
      Count += 1;
    }

    this.Log.Debug(`BroadcastInRange src=${Sender} range=${Range} reached=${Count}`);
    return Count;
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
      return { X, Y, Z, Bucket: Number.isFinite(Bucket) ? Bucket : 0 };
    } catch (Err: unknown) {
      this.Log.Warn(`Snapshot failed source=${Source}`, { Err: String(Err) });
      return null;
    }
  }
}
