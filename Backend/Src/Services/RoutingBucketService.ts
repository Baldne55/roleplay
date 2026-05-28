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

  AssignAuthBucket(Source: number): number {
    const Bucket = Source + AuthBucketOffset;
    SetPlayerRoutingBucket(String(Source), Bucket);
    this.Log.Info(`Bucket assigned - source=${Source} bucket=${Bucket}`);
    return Bucket;
  }

  MoveToWorld(Source: number): void {
    SetPlayerRoutingBucket(String(Source), 0);
    this.Log.Info(`Bucket -> world (0) - source=${Source}`);
  }
}
