/**
 * Pre-auth "skybox shell" constants.
 *
 * When a player completes the connection handshake we drop them into an
 * invisible/frozen ped at a coord far from anywhere meaningful, then frame
 * a fixed cinematic camera over Los Santos for them to look at while the
 * auth + character-select UI runs.
 *
 * Values inherited from the ragemp build's Library/Coords.cs
 * (#login_player_pos / #login_camera_pos / #login_camera_rot /
 * #login_camera_fov / #skybox_pos).
 */

export interface Vec3 {
  X: number;
  Y: number;
  Z: number;
}

export interface CameraSpec {
  Position: Vec3;
  /** Pitch / Yaw / Roll in degrees. */
  Rotation: Vec3;
  /** Vertical field of view in degrees. */
  Fov: number;
}

/**
 * Auth-phase ped position. Up in the Vinewood Hills, well clear of any
 * pedestrian/world routine. Mirrors ragemp `#login_player_pos`.
 */
export const AuthSpawnCoord: Vec3 = {
  X: 828.7,
  Y: 1278.8,
  Z: 360.3,
};

/**
 * Auth-phase cinematic camera. Mirrors ragemp `#login_camera_pos` /
 * `#login_camera_rot` / `#login_camera_fov`. Frames the city from a
 * hillside vantage looking south-east.
 */
export const AuthCinematicCamera: CameraSpec = {
  Position: { X: -436.0717, Y: 1039.26, Z: 372.1287 },
  Rotation: { X: 3.063985, Y: 0.0, Z: -170.8151 },
  Fov: 60.0,
};

/**
 * Post-character-select staging coord. Mount Chiliad peak - scenic, high
 * altitude, well clear of anything a fresh character could accidentally
 * interact with. Mirrors ragemp `#skybox_pos`. Not used yet; lands when
 * the character flow is wired.
 */
export const PostSelectSkyboxCoord: Vec3 = {
  X: 494.631,
  Y: 5586.791,
  Z: 794.164,
};

/**
 * Routing bucket assigned to a player while in the auth shell. We use
 * (Source + offset) so every connecting player sits in their own dimension
 * and can't see the others' skybox peds. 1000+ leaves the low buckets free
 * for in-world dimensions later (instances, interiors, etc.).
 */
export const AuthBucketOffset = 1000;

/**
 * Default world spawn for a freshly created character (or any character
 * whose saved position is NULL). The Airport apron in southern Los Santos
 * - flat ground, plenty of room, no immediate NPC clutter. Mirrors the
 * ragemp "Airport" entry from the legacy spawn-point picker.
 *
 * Also baked into the `characters` table as the DEFAULT for
 * position_x / position_y / position_z / heading via migration
 * 20260528000002, so a brand new character has world coords from the
 * moment of INSERT.
 */
export interface WorldAnchor {
  Coord: Vec3;
  Heading: number;
  World: number;
}

export const DefaultSpawn: WorldAnchor = {
  Coord: { X: -1038.7, Y: -2738.6, Z: 13.8 },
  Heading: 0,
  World: 0,
};
