/**
 * Shared spec for the in-world nametag overlay.
 *
 * The overlay is rendered client-side via native `DrawText` with a 3D
 * draw origin (see Frontend NametagController). Server publishes the
 * per-player data through OneSync state bags; client reads them every
 * frame for the visibility cone, every 300ms for the LOS raycast.
 *
 * Keep the bag key names + numeric thresholds in this file so the
 * writer (Backend) and the reader (Frontend) can never drift.
 */

// ── State-bag keys (Backend writes, Frontend reads) ─────────────────

export const NametagBagKeys = {
  /** Set on Spawn, cleared on Detach. Gate: renderer skips peds whose
   *  CharacterID bag is null (catches the auth shell + character-select). */
  CharacterID: 'Roleplay:CharacterID',

  /** Mask-aware display name. Re-published whenever IsMasked flips so
   *  the client never sees the legal name of a masked character. */
  DisplayName: 'Roleplay:DisplayName',

  /** Derived from BirthDate < 18 years ago at attach time. Renders as a
   *  trailing `[M]` on the name line per the minor RP convention. */
  IsMinor: 'Roleplay:IsMinor',

  /** Mirrored from the runtime. The nametag itself does not branch on
   *  this directly today - DisplayName already encodes the mask flip -
   *  but reserved for future visual cues (mask icon, etc.). */
  IsMasked: 'Roleplay:IsMasked',

  /** Healthy | Unconscious | BadlyWounded | Dead. Renders an OOC line
   *  above the name when the value is anything other than 'Healthy'. */
  InjuryStatus: 'Roleplay:InjuryStatus',

  /** Set/cleared by /ame /amy with a 5s auto-clear. String body sits
   *  at the top of the stacked nametag in purple. */
  Action: 'Roleplay:NametagAction',

  /** True while the player has the chat input bar focused. Replicated
   *  by the local Frontend on Chat:Focus on/off so other clients can
   *  render the orange `[...]` indicator. */
  IsTyping: 'Roleplay:Nametag:IsTyping',

  /** Date.now() millisecond timestamp written by the Backend's
   *  weaponDamageEvent hook when the player takes weapon damage.
   *  Server-authoritative - clients only read it - so a modified
   *  client can neither fake nor suppress the flash. Clients render
   *  the name line in red for 600ms after the timestamp. */
  DamageFlash: 'Roleplay:Nametag:DamageFlash',

  /** True only while a staff member has /aduty on. Drives the duty
   *  rank prefix + the yellow name-line tint. */
  AdminDuty: 'Roleplay:Nametag:AdminDuty',

  /** Rank label rendered as `[Label]` prefix when AdminDuty is on
   *  (matches the StaffLevel enum: Helper / Moderator / Administrator
   *  / Founder). Empty string when off-duty. */
  AdminDutyLabel: 'Roleplay:Nametag:AdminDutyLabel',

  /** Discord display name used in place of the character name while
   *  AdminDuty is on. Empty string when off-duty. */
  AdminDutyName: 'Roleplay:Nametag:AdminDutyName',

  /** Local-only preference: whether the player wants to see their own
   *  nametag floating above their own ped. Toggled via /toggle
   *  selfnametag (alias /toggle selftag). Default false. */
  SelfVisible: 'Roleplay:Nametag:SelfVisible',

  /** Local-only preference: whether to render the `(<id>)` Source ID
   *  suffix on every nametag. Toggled via /toggle nametagid (alias
   *  /toggle tagid). Default true. */
  IDVisible: 'Roleplay:Nametag:IDVisible',
} as const;

// ── Visibility + rendering thresholds ───────────────────────────────

/** Max distance (in metres) at which a nametag is visible. Beyond
 *  this, the renderer skips the ped entirely. Matches lc-rp. */
export const NametagMaxDistance = 15;

/**
 * Slack added to NametagMaxDistance for the renderer's cheap pre-cull.
 * That cull measures to the ped's ORIGIN (roughly pelvis height) rather
 * than the head bone, so the margin has to cover the origin-to-head
 * offset plus the horizontal lean of an animating ped - otherwise a
 * player standing exactly at the edge could be culled by the
 * approximation before the exact head-bone test ever ran. Two metres is
 * far more than any ped's skeleton spans; it only has to be an
 * over-estimate, since anything it lets through is then measured
 * exactly.
 */
export const NametagCullMarginMeters = 2;

/** Text scale at zero distance (closest). Linear interpolation to
 *  NametagMinScale over the 0..NametagMaxDistance range. */
export const NametagMaxScale = 0.45;

/** Text scale at NametagMaxDistance (furthest). */
export const NametagMinScale = 0.3;

/** LOS raycast cadence in ms. Per-frame raycasts tank framerate; the
 *  cached result is good enough for nametag fade. */
export const NametagLosIntervalMs = 300;

/** State-bag snapshot cadence in ms. Reading ~10 bag keys per player
 *  per frame crosses the JS<->native boundary thousands of times a
 *  second; the tag text doesn't change at frame rate, so the renderer
 *  refreshes its per-player snapshot on this interval instead. Head
 *  position / distance / fade stay per-frame. */
export const NametagSnapshotIntervalMs = 200;

/** How long the name line stays red after a damage-flash timestamp. */
export const NametagDamageFlashMs = 600;

/** Vertical offset above the head bone where the lowest line of the
 *  stacked nametag is drawn (in metres). */
export const NametagHeadOffsetZ = 0.4;

/** Minor flag = age strictly less than this. */
export const MinorAgeThreshold = 18;

// ── Colour palette (RGBA tuples, matches lc-rp visual spec) ─────────

export const NametagColors = {
  /** Off-duty character name. */
  Name: [255, 255, 255, 255] as const,

  /** Staff member with /aduty on. */
  AdminDuty: [255, 235, 59, 255] as const,

  /** Purple /ame /amy action line. */
  Action: [194, 162, 218, 255] as const,

  /** Red OOC injury indicator + damage flash. */
  Injury: [244, 67, 54, 255] as const,

  /** Orange `[...]` typing indicator. */
  Typing: [255, 170, 0, 255] as const,
} as const;

/** Short staff tag rendered on the nametag while an admin is on duty. */
export type StaffLevelLabel =
  | 'Helper'
  | 'Moderator'
  | 'Administrator'
  | 'Founder';
