import type { Vec3 } from './AuthSkybox.js';

/**
 * Static hospital roster. Used by InjuryService to pick the nearest
 * respawn point on `/acceptdeath`. Hardcoded for now; a POI editor /
 * faction-managed hospital map can replace this with a DB-backed lookup
 * later, but the interface stays the same.
 *
 * Only LS hospitals — Round 4 keeps the world to Los Santos until VC /
 * LC content lands. Coordinates are the standard GTA V map locations
 * every FiveM RP server uses, picked off the ground floor of the
 * building so a freshly respawned ped does not fall through geometry.
 */
export interface Hospital {
  Name: string;
  Coord: Vec3;
  Heading: number;
  World: number;
}

/**
 * Respawn destinations for /acceptdeath. The nearest entry to the point
 * of death is chosen, so coverage matters more than count - a region with
 * no nearby entry sends its casualties across the map.
 */
export const Hospitals: readonly Hospital[] = [
  {
    Name: 'Pillbox Medical Center',
    Coord: { X: 295.85, Y: -1446.45, Z: 29.97 },
    Heading: 230.0,
    World: 0,
  },
  {
    Name: 'Mount Zonah Medical Center',
    Coord: { X: -448.5, Y: -340.2, Z: 34.5 },
    Heading: 87.0,
    World: 0,
  },
];
