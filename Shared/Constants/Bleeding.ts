/**
 * Bleeding constants shared between Backend and Frontend.
 *
 * The escalation / drip / drain state machine lives in
 * [Backend/Src/Services/BleedingService.ts]; the client side reads the
 * replicated status bag and applies the movement restrictions and
 * stumble reactions. Both sides agree on the progression order, the
 * timer cadences, the HP floors, and the toast strings declared here.
 *
 * The `BleedingStatus` enum itself lives alongside the rest of the
 * character schema in [./Character.ts] — this module only carries the
 * values *around* it (progression order, intervals, profiles, strings).
 */
import type { BleedingStatus } from './Character.js';
import { ItemTypes } from './ItemTypes.js';

/**
 * Replicated state-bag key carrying the player's current BleedingStatus.
 * Server-owned end to end like every `Roleplay:` bag key (the anti-cheat
 * tamper watch treats any client write as hostile); the client movement
 * layer reads it to pick the matching BleedingMovement profile.
 */
export const BleedingStatusBagKey = 'Roleplay:BleedingStatus';

/**
 * Linear escalation order. Each confirmed bleeding-capable hit advances
 * exactly one slot; relief consumables walk the same list backwards
 * (StepDown) or jump straight to the head of it (Clear).
 */
export const BleedingProgression: readonly BleedingStatus[] = [
  'NotBleeding',
  'LightBleeding',
  'MediumBleeding',
  'HeavyBleeding',
];

/**
 * Server scheduler tick. One interval drives every per-player drip and
 * drain timer rather than one setInterval per wound — 1 s granularity
 * comfortably resolves the fastest cadence in the tables below (3 s).
 */
export const BleedingLoopIntervalMs = 1_000;

/**
 * Escalation cooldown. Confirmed hits arriving within this window of
 * the last tier advancement do not advance again, so a sustained burst
 * counts as one wound rather than walking the victim straight to
 * HeavyBleeding in a single exchange.
 */
export const BleedingEscalationCooldownMs = 5_000;

/**
 * Wait between a qualifying hit event and the tier escalation. A single
 * trigger pull can raise several damage events within milliseconds
 * (shotgun pellets, burst fire); the confirm delay coalesces them into
 * one wound before the tier advances.
 */
export const BleedingHitConfirmDelayMs = 1_500;

/**
 * Blood-splat drip cadence per tier. Every elapsed interval lays one
 * blood_splat evidence fixture at the bleeder's feet; null = the tier
 * leaves no trail.
 */
export const BleedingDripIntervalMs: Record<BleedingStatus, number | null> = {
  NotBleeding: null,
  LightBleeding: 60_000,
  MediumBleeding: 25_000,
  HeavyBleeding: 10_000,
};

/**
 * HP-drain cadence per tier. Every elapsed interval costs
 * BleedingDrainHpPerTick until the tier's floor; null = the tier does
 * not drain at all. LightBleeding deliberately only drips — it is a
 * roleplay prompt, not a health threat.
 */
export const BleedingDrainIntervalMs: Record<BleedingStatus, number | null> = {
  NotBleeding: null,
  LightBleeding: null,
  MediumBleeding: 10_000,
  HeavyBleeding: 3_000,
};

/** Column-range HP lost per elapsed drain interval. */
export const BleedingDrainHpPerTick = 1;

/**
 * Client-side sanity ceiling on a drain tick's |HpDelta|, mirroring
 * WithdrawalMaxAbsHpDelta. Derived from the per-tick cost rather than
 * written as a literal so raising BleedingDrainHpPerTick can never leave
 * the client silently rejecting the server's own legitimate drains. The
 * headroom absorbs a future per-tier drain without needing a second
 * constant.
 */
export const BleedingMaxAbsHpDelta = BleedingDrainHpPerTick * 5;

/**
 * Drain stops at this column-range HP per tier. MediumBleeding can
 * weaken but never down a player on its own; HeavyBleeding bleeds out
 * to 1 HP, under the injury system's critical threshold, so an
 * untreated heavy wound ends in collapse.
 */
export const BleedingDrainFloorHp: Record<BleedingStatus, number | null> = {
  NotBleeding: null,
  LightBleeding: null,
  MediumBleeding: 50,
  HeavyBleeding: 1,
};

/** Catalog ID of the evidence fixture the drip lays on the ground. */
export const BloodSplatItemTypeID = 'blood_splat';

/**
 * Minimum distance from the bleeder's previous splat before a new one
 * lands. A stationary bleeder pools into one splat instead of stacking
 * a column of identical drops on the same coordinate.
 */
export const BloodSplatMinSpacingMeters = 1.0;

/**
 * Hard cap on live splats per character. Beyond it the oldest splat is
 * recycled first — bounds both the ground-drop table and the proximity
 * broadcast cost of a long uninterrupted trail.
 */
export const BloodSplatMaxLivePerCharacter = 30;

/** Evidence lifetime. Splats older than this are swept from the world. */
export const BloodSplatMaxAgeMs = 45 * 60_000;

/** Cadence of the server-side sweep that enforces BloodSplatMaxAgeMs. */
export const BloodSplatSweepIntervalMs = 5 * 60_000;

/**
 * While bleeding heavily — and only at that tier — the ped periodically
 * stumbles (a short ragdoll) as a visible, involuntary tell that the
 * wound is untreated. Interval between stumbles and the duration of
 * each one.
 */
export const BleedingStumbleIntervalMs = 75_000;
export const BleedingStumbleDurationMs = 1_500;

/**
 * Self-only toast shown to the victim on each tier escalation.
 * Strict-formal, complete sentences, no contractions — matches the
 * rest of the chat cluster's voice.
 */
export const BleedingToast: Record<Exclude<BleedingStatus, 'NotBleeding'>, string> = {
  LightBleeding: 'You are bleeding lightly.',
  MediumBleeding: 'You are bleeding steadily. Use a bandage or seek medical attention.',
  HeavyBleeding: 'You are bleeding heavily. Seek medical attention immediately.',
};

/** Relief toast when a consumable clears the bleeding outright. */
export const BleedingReliefToastStopped = 'The bleeding has stopped.';

/** Relief toast when a consumable steps the tier down but a wound remains. */
export const BleedingReliefToastSlowed = 'The bleeding slows.';

/**
 * Per-tier movement restriction profile the client applies off the
 * replicated status bag. Null / false fields mean "leave the engine
 * default alone" so NotBleeding is a full reset.
 */
export interface BleedingMovementProfile {
  /** Movement clipset to load and apply; null restores the default. */
  Clipset: string | null;
  DisableSprint: boolean;
  DisableJump: boolean;
  /** SetPedMoveRateOverride factor; null leaves the rate untouched. */
  MoveRateOverride: number | null;
}

/**
 * Movement consequences per tier. LightBleeding is cosmetic-only; the
 * injured walk arrives at MediumBleeding, and HeavyBleeding additionally
 * forbids jumping and slows the overall move rate. The profile must be
 * re-applied after a model swap (see ClientEvents.SpawnDressingComplete)
 * because SetPlayerModel silently clears clipsets.
 */
export const BleedingMovement: Record<BleedingStatus, BleedingMovementProfile> = {
  NotBleeding: { Clipset: null, DisableSprint: false, DisableJump: false, MoveRateOverride: null },
  LightBleeding: { Clipset: null, DisableSprint: false, DisableJump: false, MoveRateOverride: null },
  MediumBleeding: {
    Clipset: 'move_m@injured',
    DisableSprint: true,
    DisableJump: false,
    MoveRateOverride: null,
  },
  HeavyBleeding: {
    Clipset: 'move_m@injured',
    DisableSprint: true,
    DisableJump: true,
    MoveRateOverride: 0.85,
  },
};

/**
 * Catalog weapons whose hits never open a bleeding wound: blunt trauma
 * does not break the skin; blades and bullets do. Blades (knife,
 * machete, hatchet, switchblade, battleaxe, dagger, broken bottle)
 * deliberately stay OUT of this set. Throwables are excluded in the
 * index build itself, not here. The electroshock pair (stun gun, stun
 * rod) is excluded as a design call: shock burns do not open bleeding
 * wounds.
 */
export const NonBleedingWeaponItemIDs: ReadonlySet<string> = new Set([
  'weapon_bat',
  'weapon_crowbar',
  'weapon_hammer',
  'weapon_flashlight',
  'weapon_knuckle',
  'weapon_nightstick',
  'weapon_poolcue',
  'weapon_wrench',
  'weapon_golfclub',
  'weapon_candycane',
  'weapon_stunrod',
  'weapon_stungun',
  'weapon_stungun_mp',
  'weapon_metaldetector',
  'weapon_fireextinguisher',
  'weapon_petrolcan',
  'weapon_hazardcan',
  'weapon_fertilizercan',
  'weapon_hackingdevice',
]);

/**
 * Lazily-built hash -> bleeds index over the weapon catalog, normalised
 * to uint32 (joaat hashes cross the wire sign-ambiguous). Built on first
 * call rather than at module load so the spread-heavy ItemTypes literal
 * is paid for exactly once, and only by processes that score hits.
 */
let WeaponBleedIndex: Map<number, boolean> | null = null;

/**
 * Whether a hit from this weapon hash opens a bleeding wound. False for
 * hashes absent from the catalog (unarmed, vehicle, fall damage), for
 * throwables (explosive trauma routes through the injury system, not a
 * wound tier), and for the blunt-melee exclusion set above.
 */
export function DoesWeaponCauseBleeding(WeaponHash: number): boolean {
  if (WeaponBleedIndex === null) {
    WeaponBleedIndex = new Map<number, boolean>();
    for (const Definition of Object.values(ItemTypes)) {
      if (Definition.IsWeapon === true && Definition.WeaponHash !== undefined) {
        const Bleeds =
          Definition.IsThrowable !== true && !NonBleedingWeaponItemIDs.has(Definition.ID);
        WeaponBleedIndex.set(Definition.WeaponHash >>> 0, Bleeds);
      }
    }
  }
  return WeaponBleedIndex.get(WeaponHash >>> 0) === true;
}
