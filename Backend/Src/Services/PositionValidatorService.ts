import { Logger } from '@/Util/Logger.js';

declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(Entity: number): { x: number; y: number; z: number } & [number, number, number];
declare function GetEntityHeading(Entity: number): number;
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;

/**
 * Anti-teleport position-delta validator. Operates entirely server-side
 * via FiveM server natives - no client trust.
 *
 *   - Spawn pathway calls Seed(Source, initial coord) when a character
 *     enters the world. That value is sane by construction (server
 *     placed the ped there).
 *   - A recurring tick reads GetEntityCoords / GetEntityHeading /
 *     GetPlayerRoutingBucket from the engine. If the per-tick distance
 *     to the previous sane value exceeds the threshold, the snapshot is
 *     discarded (last-sane stays in the cache) and a violation count
 *     ticks up.
 *   - Disconnect / character-switch reads `Get(Source)` and persists
 *     that value rather than a fresh native read - any in-progress
 *     teleport hack at the moment of disconnect lands on the last
 *     verified coord instead.
 *   - SetServerOverride lets future server-driven teleports (interior
 *     entry, jail, hospital, /tp admin) bypass the validator by
 *     resetting the baseline. Without this, a legitimate server
 *     teleport would trip the next tick.
 *
 * Threshold: 200m per tick @ 2s interval = ~100 m/s average. Covers
 * most legitimate vehicles (top-end supercars ~80 m/s, jets ~150 m/s
 * sustained but they ramp up smoothly, never single-tick jumps).
 * Catches obvious teleports of >200m in a 2s window. Tune later via
 * config when movement-aware mode lands (vehicle vs foot threshold).
 */
export interface ValidatedPosition {
  X: number;
  Y: number;
  Z: number;
  Heading: number;
  World: number;
}

interface ValidatorEntry {
  Last: ValidatedPosition;
  LastTickMs: number;
  Violations: number;
  /**
   * Until this monotonic timestamp, ticks update `Last` without
   * threshold checks. Set on Seed (post-spawn model-load can take
   * several seconds, during which the engine briefly reports the
   * pre-spawn coord) and on SetServerOverride (teleport just landed,
   * the next native read will look like a huge jump).
   */
  GraceUntilMs: number;
}

export class PositionValidatorService {
  private readonly Log = Logger.New('PositionValidator');
  private readonly Cache = new Map<number, ValidatorEntry>();
  private readonly TickIntervalMs = 2000;
  private readonly MaxDeltaMetersPerTick = 200;
  /**
   * A coord whose XYZ all fall within this radius of world origin is
   * treated as "not yet loaded" - the engine reports (0, 0, 0) for a
   * brief window during ped spawn / model swap. Persisting that lands
   * the player in the ocean on next login.
   */
  private readonly OriginRadius = 5;
  private TickHandle: NodeJS.Timeout | null = null;

  Start(): void {
    if (this.TickHandle !== null) return;
    this.TickHandle = setInterval(() => this.Tick(), this.TickIntervalMs);
    this.Log.Debug(
      `Started - tick=${this.TickIntervalMs}ms threshold=${this.MaxDeltaMetersPerTick}m`,
    );
  }

  Stop(): void {
    if (this.TickHandle === null) return;
    clearInterval(this.TickHandle);
    this.TickHandle = null;
  }

  /**
   * Establish the baseline sane coord when a character spawns. The
   * spawn pathway has just placed the ped via SetEntityCoords on the
   * client; server-side this is the authoritative starting point.
   */
  Seed(Source: number, Position: ValidatedPosition): void {
    const Now = Date.now();
    this.Cache.set(Source, {
      Last: { ...Position },
      LastTickMs: Now,
      Violations: 0,
      GraceUntilMs: Now + 5000,
    });
    this.Log.Debug(
      `Seeded source=${Source} at (${Position.X.toFixed(1)}, ${Position.Y.toFixed(1)}, ${Position.Z.toFixed(1)})`,
    );
  }

  /**
   * Read the last sane position. Used by the disconnect persist path
   * so the saved coord is one the validator vouched for (not a fresh
   * native read that could include an in-flight hack).
   */
  Get(Source: number): ValidatedPosition | null {
    return this.Cache.get(Source)?.Last ?? null;
  }

  /**
   * Atomic fetch + remove. Called from playerDropped / character-switch
   * so a reconnect on the same Source can't race against a late save.
   */
  Detach(Source: number): ValidatedPosition | null {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) return null;
    this.Cache.delete(Source);
    return Entry.Last;
  }

  /**
   * Reset the baseline after a server-driven teleport (interior entry,
   * /tp admin, jail, hospital). Without this the next tick reports a
   * huge delta against a stale baseline and trips the validator.
   */
  SetServerOverride(Source: number, Position: ValidatedPosition): void {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) {
      this.Seed(Source, Position);
      return;
    }
    const Now = Date.now();
    Entry.Last = { ...Position };
    Entry.LastTickMs = Now;
    Entry.GraceUntilMs = Now + 2000;
  }

  private Tick(): void {
    const Now = Date.now();
    for (const [Source, Entry] of this.Cache.entries()) {
      try {
        const SrcStr = String(Source);
        const Ped = GetPlayerPed(SrcStr);
        if (Ped === 0) continue;

        const Coords = GetEntityCoords(Ped);
        const X = Number(Coords[0]);
        const Y = Number(Coords[1]);
        const Z = Number(Coords[2]);
        if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) {
          continue;
        }

        // Skip near-origin reads - the engine briefly reports (0,0,0)
        // during model swap / scene load.
        if (
          Math.abs(X) < this.OriginRadius &&
          Math.abs(Y) < this.OriginRadius &&
          Math.abs(Z) < this.OriginRadius
        ) {
          continue;
        }

        const InGrace = Now < Entry.GraceUntilMs;
        if (!InGrace) {
          const Dx = X - Entry.Last.X;
          const Dy = Y - Entry.Last.Y;
          const Dz = Z - Entry.Last.Z;
          const Meters = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);

          if (Meters > this.MaxDeltaMetersPerTick) {
            Entry.Violations += 1;
            this.Log.Warn(
              `Delta over threshold: source=${Source} ${Meters.toFixed(1)}m in ${(
                (Now - Entry.LastTickMs) / 1000
              ).toFixed(1)}s violations=${Entry.Violations}`,
            );
            // Hold the previous sane coord; do NOT update Last.
            continue;
          }
        }

        const Heading = Number(GetEntityHeading(Ped));
        const World = Number(GetPlayerRoutingBucket(SrcStr));
        Entry.Last.X = X;
        Entry.Last.Y = Y;
        Entry.Last.Z = Z;
        Entry.Last.Heading = Number.isFinite(Heading) ? Heading : Entry.Last.Heading;
        Entry.Last.World = Number.isFinite(World) ? World : Entry.Last.World;
        Entry.LastTickMs = Now;
      } catch (Err: unknown) {
        this.Log.Error(`Tick failed for source=${Source}`, { Err: String(Err) });
      }
    }
  }
}
