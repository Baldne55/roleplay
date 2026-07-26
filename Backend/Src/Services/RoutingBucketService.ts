import { AuthBucketOffset } from '@Shared/Constants/AuthSkybox.js';
import { Logger } from '@/Util/Logger.js';

declare function SetPlayerRoutingBucket(PlayerSrc: string, Bucket: number): void;

/**
 * Routing buckets isolate players into independent "dimensions" - entities
 * in bucket A are invisible to clients in bucket B. We assign every
 * connecting player a unique pre-auth bucket so their skybox ped doesn't
 * pollute the world for anyone else mid-handshake.
 *
 * Allocation: `Source + AuthBucketOffset`. Bucket 0 is the shared world
 * (where spawned characters live); low buckets stay free for future
 * instanced content (interiors, races, missions).
 */
export class RoutingBucketService {
  private readonly Log = Logger.New('Routing');

  /**
   * Put a connecting player in their own private bucket for the auth
   * shell, so the skybox is not shared and they cannot see or be seen by
   * anyone in the world before choosing a character.
   */
  AssignAuthBucket(Source: number): number {
    const Bucket = Source + AuthBucketOffset;
    SetPlayerRoutingBucket(String(Source), Bucket);
    this.Log.Debug(`Bucket assigned - source=${Source} bucket=${Bucket}`);
    return Bucket;
  }

  /**
   * Move a spawning player into the shared world bucket. The moment they
   * become visible to everyone else - and the moment proximity chat,
   * nametags and drops start applying to them.
   */
  MoveToWorld(Source: number): void {
    SetPlayerRoutingBucket(String(Source), 0);
    this.Log.Debug(`Bucket -> world (0) - source=${Source}`);
  }

  /**
   * Move a previously-spawned player back into their per-source auth
   * bucket. Mirrors AssignAuthBucket's allocation formula so the player
   * lands in the same isolated dimension they had on connect. Used by
   * mid-session transitions (/changecharacter, /logout) so the returning
   * skybox ped doesn't pollute the world for anyone else.
   */
  MoveToAuth(Source: number): number {
    const Bucket = Source + AuthBucketOffset;
    SetPlayerRoutingBucket(String(Source), Bucket);
    this.Log.Debug(`Bucket -> auth (${Bucket}) - source=${Source}`);
    return Bucket;
  }
}
