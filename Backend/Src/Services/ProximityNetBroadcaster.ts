import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Proximity-aware net-event broadcaster. Mirrors `ProximityBroadcaster`
 * for chat, but emits arbitrary net events to every spawned Source
 * within range AND in the same routing bucket as the origin.
 *
 * Two methods, both emitting through the same guarded `emitNet`:
 *
 *   EmitInRange(EventName, Payload, Origin, RangeMeters, World, ExcludeSource?)
 *     Fan-out filtered by world coordinate. Used for anything that
 *     happens at a place rather than to a person - ground drops, weapon
 *     discharges. Returns the receiver count. `ExcludeSource` omits one
 *     Source, normally the actor who caused the event.
 *
 *   EmitToSource(Source, EventName, Payload)
 *     Single-recipient send. No range check at all - this is the
 *     try/catch wrapper, not a proximity mode.
 *
 * There is no coordinate-free "follow the player" variant: a caller that
 * wants a player-centred fan-out reads that player's position and passes
 * it as Origin.
 */
/**
 * World position triple.
 *
 * Structurally identical to the Vec3 in Shared/Constants/AuthSkybox.ts and
 * deliberately NOT imported from it: that one is part of the auth-skybox
 * constant set, and this service has no reason to depend on the auth
 * feature. TypeScript's structural typing means the two interoperate
 * anyway, so the duplication costs nothing at a call site - but if a third
 * copy is ever wanted, promote one to a shared geometry module rather than
 * adding another.
 */
export interface Vec3 {
  X: number;
  Y: number;
  Z: number;
}

/**
 * Range-filtered net-event fan-out - the emitNet counterpart to
 * ProximityBroadcaster's chat fan-out. Same distance model, different
 * payload: this one carries structured events (drop spawned, weapon
 * discharge) rather than rendered chat lines, so it does no name
 * resolution and has no mask concerns.
 */
export class ProximityNetBroadcaster {
  private readonly Log = Logger.New('ProximityNet');

  constructor(private readonly State: PlayerStateService) {}

  /**
   * Emit `EventName` with `Payload` to every spawned Source inside
   * `RangeMeters` of `Origin` and in routing bucket `World`. Returns
   * the receiver count (matches `ProximityBroadcaster.BroadcastInRange`).
   */
  EmitInRange(
    EventName: string,
    Payload: unknown,
    Origin: Vec3,
    RangeMeters: number,
    World: number,
    ExcludeSource?: number,
  ): number {
    const RangeSq = RangeMeters * RangeMeters;
    let Count = 0;
    for (const Source of this.State.GetSpawnedSources()) {
      if (Source === ExcludeSource) continue;
      const Snapshot = this.SnapshotForSource(Source);
      if (Snapshot === null) continue;
      if (Snapshot.Bucket !== World) continue;
      const Dx = Snapshot.X - Origin.X;
      const Dy = Snapshot.Y - Origin.Y;
      const Dz = Snapshot.Z - Origin.Z;
      if (Dx * Dx + Dy * Dy + Dz * Dz > RangeSq) continue;
      try {
        emitNet(EventName, Source, Payload);
        Count += 1;
      } catch (Err: unknown) {
        this.Log.Warn(`emitNet failed source=${Source} event=${EventName}`, {
          Err: String(Err),
        });
      }
    }
    return Count;
  }

  /**
   * Emit to a single Source. Thin wrapper that handles the try/catch
   * so the caller does not bake one into every site.
   */
  EmitToSource(Source: number, EventName: string, Payload: unknown): void {
    try {
      emitNet(EventName, Source, Payload);
    } catch (Err: unknown) {
      this.Log.Warn(`emitNet failed source=${Source} event=${EventName}`, {
        Err: String(Err),
      });
    }
  }

  /** Read the world coord + routing bucket of a Source's ped. */
  private SnapshotForSource(
    Source: number,
  ): { X: number; Y: number; Z: number; Bucket: number } | null {
    try {
      const SrcStr = String(Source);
      const Ped = GetPlayerPed(SrcStr);
      if (Ped === 0) return null;
      const Coords = GetEntityCoords(Ped);
      const X = Number(Coords[0]);
      const Y = Number(Coords[1]);
      const Z = Number(Coords[2]);
      if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return null;
      const Bucket = Number(GetPlayerRoutingBucket(SrcStr));
      return { X, Y, Z, Bucket: Number.isFinite(Bucket) ? Bucket : 0 };
    } catch (Err: unknown) {
      this.Log.Warn(`SnapshotForSource failed source=${Source}`, { Err: String(Err) });
      return null;
    }
  }
}
