/**
 * Injury / death constants shared between Backend and Frontend.
 *
 * The state machine lives in [Backend/Src/Services/InjuryService.ts] and
 * the client visual reactions in [Frontend/Src/Controllers/InjuryController.ts];
 * both sides agree on the progression order, the HP floors, the wait
 * gates, and the nametag / narration strings declared here.
 *
 * The `InjuryStatus` and `BleedingStatus` enums themselves live alongside
 * the rest of the character schema in [./Character.ts] — this module only
 * carries the values *around* them (progression order, thresholds,
 * strings).
 */
import type { InjuryStatus } from './Character.js';

/**
 * Linear advancement order. Each lethal-damage event advances exactly
 * one slot. Dead is terminal; further hits route to hospital respawn
 * rather than off the end of this list.
 */
export const InjuryProgression: readonly InjuryStatus[] = [
  'Healthy',
  'Unconscious',
  'BadlyWounded',
  'Dead',
];

/** Full health after `/arevive` / `/acceptdeath`. GTA range; not the +100 offset. */
export const HpHealthy = 100;
export const HpRevived = 100;

/** `/helpup` lifts an unconscious player to half health, not a full medic. */
export const HpHelpedUp = 50;

/**
 * Clamp value the server pins to a freshly downed ped. Five rather than
 * zero so the engine never observes an HP=0 frame (which would trip the
 * native WASTED cycle the client is suppressing).
 */
export const HpInjuredFloor = 5;

/**
 * Client-side health-poll threshold. When the GTA-range ped HP (0-200,
 * 100=floor of alive) crosses below `100 + HpCriticalThreshold` and we
 * are currently `Healthy`, the client emits HealthCritical. The server
 * then clamps, advances state, and broadcasts narration.
 */
export const HpCriticalThreshold = 10;

/** 2-minute mandatory wait before `/acceptdeath` succeeds. */
export const AcceptDeathWaitMs = 2 * 60 * 1000;

/**
 * Cascade cooldown. Multiple HealthCritical events arriving within this
 * window of the last advancement are dropped on the floor. Filters out
 * ragdoll-physics fall damage that fires 1-2 s after the death animation
 * starts and would otherwise count as a second death.
 */
export const AdvancementCooldownMs = 10 * 1000;

/** Client health-poll tick interval. 250 ms is fast enough to catch one-shot lethal hits. */
export const HealthPollIntervalMs = 250;

/** `/helpup` proximity requirement. */
export const HelpUpRangeMeters = 3;

/**
 * Red OOC badge rendered above the head when the player is non-Healthy.
 * The nametag overlay reads `Roleplay:InjuryStatus` and picks the line
 * from here. Strings deliberately match the lc-rp / ragemp wording so
 * the OOC framing is consistent with existing RP muscle memory.
 */
export const InjuryNametagText: Record<Exclude<InjuryStatus, 'Healthy'>, string> = {
  Unconscious: '(( This player is unconscious. ))',
  BadlyWounded: '(( This player is badly wounded. ))',
  Dead: '(( This player is dead. ))',
};

/**
 * Purple `/me` auto-narration body for each transition. Broadcast at
 * Say range via ProximityBroadcaster. Strict-formal, single sentence,
 * no contractions — matches the rest of the chat cluster's voice.
 */
export const InjuryNarration: Record<Exclude<InjuryStatus, 'Healthy'>, string> = {
  Unconscious: 'collapses to the ground.',
  BadlyWounded: 'appears to slip further from consciousness.',
  Dead: 'has died.',
};
