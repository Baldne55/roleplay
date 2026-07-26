/**
 * Anti-cheat domain constants - shared between the Backend (detection,
 * scoring, enforcement) and the Frontend (the client monitor compares
 * local engine state against the server-declared expected state).
 *
 * Trust tiers - who vouches for the signal:
 *   1 = server-authoritative. Server natives / server-only events; the
 *       client can not suppress the check, only try to stay under it.
 *   2 = replicated sync state. OneSync nodes the client serialises;
 *       readable server-side but spoofable by a determined client.
 *   3 = client self-report. The monitor emits it; a cheat that kills
 *       the monitor kills the signal. Catches low-effort cheats only.
 *   4 = statistical / forensic. Offline analysis over persisted logs;
 *       surfaces for admin review, never auto-action.
 */

/**
 * Evidence-strength tier of a detection, per the file header above.
 * Lower is stronger: 1 is server-observed fact, 4 is a statistical hint.
 * The tier drives how much a detection is allowed to weigh in scoring -
 * it is not a severity rating, and a tier-4 hit on a serious cheat still
 * must not auto-action.
 */
export type AnticheatTier = 1 | 2 | 3 | 4;

/**
 * Every detection the pipeline can raise, as a const object so the union
 * type below derives from it and the two cannot drift.
 *
 * Adding one means adding it here AND giving it an AnticheatPolicies
 * entry - the Record type makes a missing policy a compile error, which
 * is deliberate: a detection with no weight would score silently forever.
 */
export const AnticheatDetectionTypes = {
  /** Position delta over threshold while on foot (PositionValidator tick). */
  OnFootTeleport: 'OnFootTeleport',
  /** Position delta over threshold while occupying a vehicle. */
  InVehicleTeleport: 'InVehicleTeleport',
  /** Weapon damage arrived from a catalog firearm the server never granted. */
  WeaponNotGranted: 'WeaponNotGranted',
  /** Sustained horizontal speed on foot beyond engine-possible sprint. */
  OnFootSpeed: 'OnFootSpeed',
  /** Sustained vehicle speed beyond the fastest aircraft. */
  InVehicleSpeed: 'InVehicleSpeed',
  /** Sustained upward movement on foot - no engine mechanic produces it. */
  OnFootFly: 'OnFootFly',
  /** Single-tick vertical gain on foot beyond any jump or launch glitch. */
  SuperJump: 'SuperJump',
  /** Ped holds a weapon that does not match the equipped-weapon bag. */
  HeldWeaponMismatch: 'HeldWeaponMismatch',
  /** Shot claims kept arriving after the server-side ammo ledger ran dry. */
  InfiniteAmmo: 'InfiniteAmmo',
  /** Shot claims repeatedly breached the server rate limiter. */
  RapidBulletFire: 'RapidBulletFire',
  /** Damage landed from a granted weapon while the client shot poll stayed silent. */
  ShotsUnreported: 'ShotsUnreported',
  /** Replicated player invincibility flag set without a sanctioned state. */
  GodModeFlag: 'GodModeFlag',
  /** Repeated hits landed with no replicated HP or armour movement. */
  GodModeHealth: 'GodModeHealth',
  /** Ped model is not a server-assigned freemode model. */
  PedModelChange: 'PedModelChange',
  /** Client requested an explosion without holding an explosive-capable weapon. */
  ExplosionRequest: 'ExplosionRequest',
  /** Client created a projectile from a weapon the server never granted. */
  ProjectileNotGranted: 'ProjectileNotGranted',
  /** Projectile creation rate beyond any legitimate throw or launcher cadence. */
  ProjectileSpam: 'ProjectileSpam',
  /** Client requested map fires beyond the legitimate burn surface. */
  FireAbuse: 'FireAbuse',
  /** Client-originated weapon give to a remote ped - the server gives via RPC, never this path. */
  WeaponGiveToOther: 'WeaponGiveToOther',
  /** Client-originated weapon removal from a remote ped. */
  WeaponRemoveFromOther: 'WeaponRemoveFromOther',
  /** Client created a scripted ped or vehicle the server never sanctioned. */
  IllegalEntitySpawn: 'IllegalEntitySpawn',
  /** Client created a scripted object - lower confidence than peds/vehicles (props, parachutes). */
  IllegalObjectSpawn: 'IllegalObjectSpawn',
  /** Client cleared tasks on a remotely-owned ped (freeze/ragdoll griefing). */
  PedTaskTampering: 'PedTaskTampering',
  /** Client overrode weapon damage beyond the sane ceiling. */
  WeaponDamageModified: 'WeaponDamageModified',
  /** Stun-weapon damage cadence beyond the engine's recharge cycle. */
  TazerAbuse: 'TazerAbuse',
  /** Client monitor observed the night-vision post-FX active. */
  NightVision: 'NightVision',
  /** Client monitor observed the thermal-vision post-FX active. */
  ThermalVision: 'ThermalVision',
  /** Rendered camera sits far from the ped with no scripted camera active. */
  FreeCam: 'FreeCam',
  /** Assisted targeting mode active on keyboard-and-mouse input. */
  AimAssistOn: 'AimAssistOn',
  /** Sprint stamina never depletes. */
  InfiniteStamina: 'InfiniteStamina',
  /** Clip ammo above the component-aware engine maximum. */
  OverMaxClip: 'OverMaxClip',
  /** Ragdoll permanently blocked outside sanctioned states. */
  RagdollHack: 'RagdollHack',
  /** Own-ped alpha or visibility tampered (invisible to others). */
  PedAlphaTampering: 'PedAlphaTampering',
  /** Client-side invincibility flag (including the keep-ragdoll variant the server read misses). */
  ClientInvincibility: 'ClientInvincibility',
  /** The client monitor stopped reporting while the player stayed spawned. */
  MonitorSilent: 'MonitorSilent',
  /** A client wrote to a server-owned replicated state bag key. */
  StateBagTampering: 'StateBagTampering',
} as const;

/** A detection kind. Each carries its own score weight and alert threshold. */
export type AnticheatDetectionType = keyof typeof AnticheatDetectionTypes;

/**
 * Per-detection scoring policy. Weight accrues onto a per-Source,
 * per-type session score; crossing AlertAt notifies on-duty staff +
 * the Discord webhook, crossing KickAt drops the player when the
 * `anticheat_enforcement` convar is set to `kick` (default `observe`
 * never kicks). KickAt null = this type never auto-kicks.
 */
export interface AnticheatPolicy {
  readonly Tier: AnticheatTier;
  readonly Weight: number;
  readonly AlertAt: number;
  readonly KickAt: number | null;
}

/**
 * Scoring policy per detection - the tuning table the whole pipeline
 * rests on. Each hit adds Weight to that player's per-detection session
 * score; crossing AlertAt notifies staff, crossing KickAt drops them.
 *
 * `KickAt: null` means observe-only: the detection scores and alerts but
 * can never auto-action, which is the right setting for anything
 * tier-3/4 or otherwise prone to false positives.
 *
 * Note kicking additionally requires the `anticheat_enforcement` convar
 * to be `kick`; in the default `observe` mode KickAt is inert for every
 * entry, so these numbers can be tuned against live data before they
 * affect anyone.
 */
export const AnticheatPolicies: Record<AnticheatDetectionType, AnticheatPolicy> = {
  // One teleport flag can be a OneSync hiccup; two in a session is a
  // pattern. Alert on the second, kick (when enforcing) on the fifth.
  OnFootTeleport: { Tier: 1, Weight: 10, AlertAt: 20, KickAt: 50 },
  // Vehicles have more legitimate edge cases (towing, ramps, engine
  // catapult glitches), so the kick line sits higher.
  InVehicleTeleport: { Tier: 1, Weight: 10, AlertAt: 20, KickAt: 60 },
  // Firing a weapon the server never granted has no legitimate cause -
  // the first sighting alerts.
  WeaponNotGranted: { Tier: 1, Weight: 25, AlertAt: 25, KickAt: 75 },
  // Movement detections report once per throttle window (the validator
  // throttles per kind), so weights accrue slowly by design.
  OnFootSpeed: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: 60 },
  // Jets sustain ~150 m/s legitimately; the detector threshold sits
  // above that, but the kick line stays high for edge cases.
  InVehicleSpeed: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: 80 },
  OnFootFly: { Tier: 1, Weight: 15, AlertAt: 30, KickAt: 60 },
  // Launch glitches (vehicle clipping, explosions) can hurl a ped -
  // alert-and-watch rather than fast kick.
  SuperJump: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: 80 },
  // Tier 2: both sides of the comparison ride replicated client data
  // (sync-tree weapon + the state-bag mirror).
  HeldWeaponMismatch: { Tier: 2, Weight: 15, AlertAt: 30, KickAt: 75 },
  // The FIFO ledger is server-authoritative; repeated underflow has no
  // legitimate cause.
  InfiniteAmmo: { Tier: 1, Weight: 15, AlertAt: 30, KickAt: 75 },
  // Network jitter batches legitimate shot emits, so the detector only
  // reports sustained breaches and the kick line sits high.
  RapidBulletFire: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: 80 },
  // Timing-based heuristic - observe only, never auto-kick.
  ShotsUnreported: { Tier: 1, Weight: 15, AlertAt: 30, KickAt: null },
  GodModeFlag: { Tier: 2, Weight: 20, AlertAt: 20, KickAt: 60 },
  // Hit-window heuristic - observe only, never auto-kick.
  GodModeHealth: { Tier: 2, Weight: 15, AlertAt: 30, KickAt: null },
  PedModelChange: { Tier: 2, Weight: 15, AlertAt: 30, KickAt: 60 },
  ExplosionRequest: { Tier: 1, Weight: 20, AlertAt: 20, KickAt: 60 },
  ProjectileNotGranted: { Tier: 1, Weight: 20, AlertAt: 20, KickAt: 60 },
  ProjectileSpam: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: 80 },
  // fireEvent is undocumented (field names source-derived) - observe only.
  FireAbuse: { Tier: 1, Weight: 15, AlertAt: 30, KickAt: null },
  // Client-originated give/remove weapon events have exactly zero
  // legitimate producers in this codebase (server gives are context
  // RPCs that bypass the event path) - first sighting alerts, and the
  // kick line equals one report.
  WeaponGiveToOther: { Tier: 1, Weight: 50, AlertAt: 50, KickAt: 50 },
  WeaponRemoveFromOther: { Tier: 1, Weight: 50, AlertAt: 50, KickAt: 50 },
  IllegalEntitySpawn: { Tier: 1, Weight: 20, AlertAt: 20, KickAt: 60 },
  // Objects are low-confidence (the client legitimately streams local
  // props, parachutes) - observe only, never auto-kick.
  IllegalObjectSpawn: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: null },
  // Remote-ped task clears have fringe legitimate triggers - observe only.
  PedTaskTampering: { Tier: 1, Weight: 10, AlertAt: 30, KickAt: null },
  // Damage override reads replicated client data - observe only.
  WeaponDamageModified: { Tier: 2, Weight: 20, AlertAt: 20, KickAt: null },
  TazerAbuse: { Tier: 2, Weight: 10, AlertAt: 30, KickAt: null },
  // Tier 3 monitor self-reports: a determined cheat kills the monitor,
  // so these catch low-effort menus only and never auto-kick.
  NightVision: { Tier: 3, Weight: 10, AlertAt: 20, KickAt: null },
  ThermalVision: { Tier: 3, Weight: 10, AlertAt: 20, KickAt: null },
  // Known-spoofed by current menus; scripted cameras must be whitelisted
  // client-side before this fires.
  FreeCam: { Tier: 3, Weight: 10, AlertAt: 30, KickAt: null },
  AimAssistOn: { Tier: 3, Weight: 10, AlertAt: 30, KickAt: null },
  InfiniteStamina: { Tier: 3, Weight: 10, AlertAt: 30, KickAt: null },
  OverMaxClip: { Tier: 3, Weight: 15, AlertAt: 30, KickAt: null },
  // Legitimate scripts block ragdoll during animations - heavily
  // deprioritised.
  RagdollHack: { Tier: 3, Weight: 5, AlertAt: 50, KickAt: null },
  PedAlphaTampering: { Tier: 3, Weight: 15, AlertAt: 30, KickAt: null },
  ClientInvincibility: { Tier: 3, Weight: 15, AlertAt: 30, KickAt: null },
  // Server-observed absence of the monitor - strong signal, but resource
  // restarts and load hitches produce gaps, so observe only.
  MonitorSilent: { Tier: 2, Weight: 15, AlertAt: 30, KickAt: null },
  // A client has no legitimate write path to server-owned bag keys -
  // first sighting alerts, and the kick line equals one report.
  StateBagTampering: { Tier: 1, Weight: 50, AlertAt: 50, KickAt: 50 },
};

/** Minimum gap between staff alerts for the same Source + type. */
export const AnticheatAlertCooldownMs = 60_000;

/**
 * Expected-state registry keys. The server records the expected value
 * of cheat-shaped client states (sanctioned noclip, invincibility
 * windows, assigned ped model) and mirrors each onto a replicated
 * player state bag so the client monitor can compare engine truth
 * against it. The ledger of record is ALWAYS the server-memory map in
 * AnticheatService - the bag is a broadcast mirror, never read back
 * server-side, because a client can overwrite its own bag keys.
 */
export const AnticheatExpectedStateKeys = {
  NoClip: 'NoClip',
} as const;

/** A ped-state key the scanner samples and compares against its expected value. */
export type AnticheatExpectedStateKey = keyof typeof AnticheatExpectedStateKeys;

/** Replicated mirror bag key for an expected-state entry. */
export function AnticheatExpectedStateBagKey(Key: AnticheatExpectedStateKey): string {
  return `Roleplay:Anticheat:${Key}`;
}

/**
 * joaat('WEAPON_UNARMED') - verified computationally 2026-06-11. The
 * held-weapon scanner treats unarmed as "no weapon in hand".
 */
export const WeaponUnarmedHash = 0xa2719263;

/**
 * joaat('mp_m_freemode_01') / joaat('mp_f_freemode_01') - verified
 * computationally 2026-06-11. Every server-assigned character model is
 * one of the two freemode peds; anything else on a player ped is a
 * model swap.
 */
export const AllowedPedModelHashes: readonly number[] = [
  0x705e61f2, // mp_m_freemode_01
  0x9c9effd8, // mp_f_freemode_01
];

/**
 * joaat('WEAPON_STUNGUN') / joaat('WEAPON_STUNGUN_MP') - verified
 * computationally 2026-06-11. Both stun variants feed the TazerAbuse
 * cadence check.
 */
export const StunWeaponHashes: readonly number[] = [
  0x3656c8c1, // WEAPON_STUNGUN
  0x45cd9cf3, // WEAPON_STUNGUN_MP
];

/**
 * Client monitor cadence. The periodic report doubles as the heartbeat:
 * the Backend flags a Source whose last report is older than
 * MonitorSilentThresholdMs while still spawned. The server-side ingest
 * refuses reports arriving faster than MonitorReportMinIntervalMs.
 */
export const MonitorReportIntervalMs = 10_000;
export const MonitorReportMinIntervalMs = 5_000;
export const MonitorSilentThresholdMs = 30_000;
