/**
 * Net events - Backend <-> Frontend channel.
 *
 * Cross the FiveM net protocol (TriggerClientEvent / RegisterNetEvent on
 * server, onNet / emitNet on client). Every inbound payload from the
 * client is HOSTILE - services MUST validate before acting.
 *
 * Format: `Roleplay:Net:<Domain>:<VerbNoun>` (PascalCase, all-caps acronyms).
 */
import type { CameraSpec, Vec3 } from '../Constants/AuthSkybox.js';
import type {
  AppearanceData,
  BloodType,
  CharacterSpawnPayload,
  CharacterSummary,
  Gender,
} from '../Constants/Character.js';
import type { OutfitData } from '../Constants/Outfit.js';
import type { AccountSettings } from '../Constants/AccountSettings.js';
import type { CommandHint } from '../Chat/Index.js';

/**
 * Every server <-> client event name. Const object rather than an enum so
 * the NetEventName union and the NetEventPayloads keys both derive from
 * it; a name added without a payload entry fails to compile at the emit
 * site.
 *
 * Direction is documented per entry and is not encoded in the name -
 * check the entry before wiring a handler, because registering a
 * server->client name with `onNet` on the server silently never fires.
 */
export const NetEvents = {
  /**
   * Server -> client. Fired on playerJoining once the queue admits the
   * player, Discord identity + guild gate pass, and the routing bucket
   * is assigned. Payload carries everything the client needs to enter
   * the auth skybox shell (spawn coord, cinematic camera).
   */
  AuthInit: 'Roleplay:Net:Auth:Init',

  /**
   * Server -> client. Fired immediately after AuthInit. Carries the
   * Discord profile preview so the auth card can render "Welcome,
   * {DisplayName}" + avatar before the player clicks Enter.
   */
  AuthPrepared: 'Roleplay:Net:Auth:Prepared',

  /**
   * Client -> server. Player clicked "Enter Server" in the UI. Server
   * runs the session-uniqueness check (kicks any other Source claiming
   * this account), then flips Phase=Authenticated and fires AuthSuccess.
   */
  AuthFinalize: 'Roleplay:Net:Auth:Finalize',

  /**
   * Server -> client. Phase=Authenticated; UI should route to the next
   * view (character-select lands here later).
   */
  AuthSuccess: 'Roleplay:Net:Auth:Success',

  /**
   * Server -> client. Auth-side failure that doesn't warrant a kick
   * (e.g. database transient on Finalize). UI clears the loading state
   * and shows the reason inline. Hard failures (no Discord, not in
   * guild) use DropPlayer instead, never this event.
   */
  AuthFailure: 'Roleplay:Net:Auth:Failure',

  /**
   * Client -> server. Final submit from the character-creation wizard.
   * Carries the full DetailsView + creator payload. Server re-validates
   * every field (no client trust), generates forensic IDs, and writes
   * the row. Replies via CharacterCreateSuccess / CharacterCreateFailure.
   */
  CharacterCreate: 'Roleplay:Net:Character:Create',

  /**
   * Server -> client. Character row created. Carries the bare minimum
   * the UI needs to flip out of the create flow (ID + slot + display
   * name); spawn / appearance application happens on a follow-up event.
   */
  CharacterCreateSuccess: 'Roleplay:Net:Character:CreateSuccess',

  /**
   * Server -> client. Create rejected (validation, name taken, etc.).
   * UI clears loading state and surfaces Reason inline on the offending
   * step.
   */
  CharacterCreateFailure: 'Roleplay:Net:Character:CreateFailure',

  /**
   * Client -> server. Selector view requests the account's character
   * list. Server projects to CharacterSummary[] and replies via
   * CharacterListResponse. Read-only; no payload.
   */
  CharacterList: 'Roleplay:Net:Character:List',

  /**
   * Server -> client. Carries the projected summary list. Forwarded to
   * the UI as CharacterListLoaded.
   */
  CharacterListResponse: 'Roleplay:Net:Character:ListResponse',

  /**
   * Client -> server. Player picked a character on the selector. Server
   * verifies ownership, loads the row + active outfit, stamps
   * LastLoginAt, flips PlayerPhase=Spawned, switches the routing bucket
   * to the world, and replies via CharacterSpawned.
   */
  CharacterSelect: 'Roleplay:Net:Character:Select',

  /**
   * Server -> client. Carries the full spawn payload so the Frontend
   * can dress the freemode ped + place it in the world. Reused both
   * after CharacterSelect (returning player) and after CharacterCreate
   * (auto-spawn the freshly created character).
   */
  CharacterSpawned: 'Roleplay:Net:Character:Spawned',

  /**
   * Server -> client. Select rejected (forge attack, character not
   * found, etc.). Generic reason - never leaks why a given ID failed
   * the ownership check.
   */
  CharacterSelectFailure: 'Roleplay:Net:Character:SelectFailure',

  /**
   * Server -> client. Render a chat line. Body is a token-formatted
   * string of the shape `!{#RRGGBB}...!{#FFFFFF}`; the UI parses it
   * into Segments and renders one <span> per coloured run.
   */
  ChatPush: 'Roleplay:Net:Chat:Push',

  /**
   * Client -> server. Player submitted a line in the chat overlay.
   * Server validates phase / rate-limit / length, then dispatches to
   * the command registry (slash-prefix) or rejects.
   */
  ChatSubmit: 'Roleplay:Net:Chat:Submit',

  /**
   * Server -> client. Wipe the local scrollback. Forward-compat surface
   * for a future /clearchat; no command in this slice emits it.
   */
  ChatClear: 'Roleplay:Net:Chat:Clear',

  /**
   * Server -> client. Snapshot of every registered command, pushed once
   * after spawn. Drives the autocomplete suggestion box.
   */
  ChatCommandList: 'Roleplay:Net:Chat:CommandList',

  /**
   * Client -> server. The local chat input gained or lost focus. The
   * server writes the replicated `Roleplay:Nametag:IsTyping` bag itself
   * (CharacterRuntimeService.SetTyping) rather than letting the client
   * write it: the `Roleplay:` bag namespace is server-owned end to end,
   * so the anti-cheat state-bag tamper watch can treat ANY client write
   * to a `Roleplay:` key as hostile with no legitimate exception.
   */
  ChatTypingState: 'Roleplay:Net:Chat:TypingState',

  /**
   * Server -> client. Spawned player is leaving the world back to the
   * character selector (e.g. /changecharacter). Frontend tears down the
   * spawned state, the SPA resets the list store and routes to
   * /Character/Select, chat input goes read-only again.
   */
  SessionReturnToSelect: 'Roleplay:Net:Session:ReturnToSelect',

  /**
   * Server -> client. Spawned player is leaving the world back to the
   * auth shell (e.g. /logout). Frontend restores the auth panorama, the
   * SPA flips the Auth phase back to Prepared and routes to /Auth so the
   * player can click Enter Server again. The connection itself stays open.
   */
  SessionReturnToAuth: 'Roleplay:Net:Session:ReturnToAuth',

  /**
   * Client -> server. SPA pushed a partial settings update (theme
   * change, future preferences). Server validates, merges over current,
   * persists, and echoes the resolved snapshot back via SettingsPushed.
   */
  SettingsUpdate: 'Roleplay:Net:Settings:Update',

  /**
   * Server -> client. Echoes the post-merge settings after a successful
   * SettingsUpdate (or any future admin-driven settings push). Lets the
   * UI sync write-back state without round-tripping a refetch.
   */
  SettingsPushed: 'Roleplay:Net:Settings:Pushed',

  /**
   * Server -> client. A /toggle / /fontsize / /pagesize command landed
   * on the server side; the SPA flips or updates the corresponding
   * local setting. Toggles carry no value (the SPA flips its own
   * boolean); /fontsize and /pagesize carry the new numeric value.
   */
  ChatSettingChanged: 'Roleplay:Net:Chat:SettingChanged',

  /**
   * Client -> server. Local health-poll tick observed the player's ped
   * HP cross below the critical threshold while in a Healthy state.
   * Payload is empty by design - Source is the FXServer netId of the
   * connection (forge-proof), and the server reads the ped's coords
   * + current InjuryStatus authoritatively rather than trusting any
   * client-supplied position or status delta. The server applies a
   * cascade cooldown so a spam client can not advance state faster
   * than an honest one.
   */
  InjuryHealthCritical: 'Roleplay:Net:Injury:HealthCritical',

  /**
   * Server -> client. The server has authoritatively decided the target
   * ped's new HP / armour / world position after an injury transition
   * (lethal hit clamp, /acceptdeath hospital respawn, /helpup partial
   * restore, /arevive full restore) and is asking the client to apply
   * the engine-side natives. Necessary because SetEntityHealth /
   * SetPedArmour / SetEntityCoordsNoOffset / SetEntityHeading are
   * client-only in FXServer - the server can read ped state but can
   * not write it. The accompanying state-bag write
   * (Roleplay:InjuryStatus) drives the visual pose + suppression tick;
   * this event drives the underlying HP + position state.
   */
  InjuryApply: 'Roleplay:Net:Injury:Apply',

  /**
   * Server -> client. One bleed-out drain tick landed on this player.
   * Carries a column-range HP *delta* (negative = loss) the client
   * applies atomically against its live engine HP. A delta rather than
   * an absolute write because SET_ENTITY_HEALTH has no server apiset
   * variant - an absolute-HP instruction computed server-side would
   * race concurrent gunfire and resurrect damage dealt in flight.
   */
  BleedingDrainTick: 'Roleplay:Net:Bleeding:DrainTick',

  /**
   * Server -> client. One consumable HP-regen tick landed on this
   * player (the medkit's over-time window). Carries a column-range HP
   * *delta* (positive = gain) applied atomically against the live
   * engine HP - the same relative-not-absolute reasoning as
   * BleedingDrainTick, mirrored: an absolute heal target computed
   * server-side would race concurrent gunfire and erase damage dealt
   * in flight.
   */
  InjuryRegenTick: 'Roleplay:Net:Injury:RegenTick',

  /**
   * Server -> client. One withdrawal symptom drained this player.
   * Relative negative column-range delta - same compose-not-overwrite
   * rationale as the bleeding drain. The server gates on the
   * withdrawal floor before emitting; the client refuses to cross it
   * even if an instruction slips through.
   */
  AddictionWithdrawalTick: 'Roleplay:Net:Addiction:WithdrawalTick',

  /**
   * Server -> client. /noclip flipped this admin's free-fly state.
   * Targets the issuer only; the server keeps the on/off set as the
   * source of truth so a reconnect-while-noclipping or a duplicate
   * /noclip can not desync state. The client toggles ped visibility,
   * collision, freeze, and the per-frame camera-relative movement
   * tick based on `On`.
   */
  AdminNoClipToggle: 'Roleplay:Net:Admin:NoClipToggle',

  /**
   * Client -> server. Player typed /item drop; the client emits the
   * intent so the server can re-read ped coords (advisory client
   * coords are NOT trusted). Server runs the lock + transaction +
   * GroundDropRepo.Create + ProximityNetBroadcaster.Emit cycle.
   */
  InventoryDropRequest: 'Roleplay:Net:Inventory:DropRequest',

  /**
   * Client -> server. Player typed /item pickup; the client sends
   * the cached DropID resolved from the most recent /item nearby
   * listing.
   */
  InventoryPickupRequest: 'Roleplay:Net:Inventory:PickupRequest',

  /**
   * Client -> server. Local ammo poll observed the equipped ammo
   * drop below the last-sampled value. Payload carries the client's
   * reading as advisory; the server is authoritative and clamps the
   * pop against its own FIFO accounting. The weapon natives
   * themselves (give / remove / SetPedAmmo) run server-side - this
   * event exists only because FXServer has no apiset-server ammo
   * *getter* to observe discharges with.
   */
  InventoryWeaponShot: 'Roleplay:Net:Inventory:WeaponShot',

  /**
   * Client -> server. Player typed /item reload; the server consumes
   * compatible loose ammo from inventory and applies the new total
   * via the server-side SetPedAmmo native.
   */
  InventoryWeaponReloadRequest: 'Roleplay:Net:Inventory:WeaponReloadRequest',

  /**
   * Server -> client. A ground drop entered the receiver's
   * proximity. Spawns a placeholder prop + a 3D label with the
   * nametag-style distance fade.
   */
  InventoryGroundDropSpawn: 'Roleplay:Net:Inventory:GroundDropSpawn',

  /**
   * Server -> client. A ground drop was picked up / cleared.
   * Despawns the prop + label.
   */
  InventoryGroundDropDespawn: 'Roleplay:Net:Inventory:GroundDropDespawn',

  /**
   * Client -> server. Fired by the client after a fresh spawn so the
   * server can re-broadcast ground drops already persisted in the DB
   * (which would otherwise be invisible because their original
   * GroundDropSpawn broadcast happened before the client connected).
   */
  InventoryGroundDropResyncRequest: 'Roleplay:Net:Inventory:GroundDropResyncRequest',

  /**
   * Server -> client. `/aitem testcatalog` gave the admin's ped every
   * catalog weapon server-side; the client should now sweep the whole
   * weapon catalog through the engine's own validity natives
   * (IsWeaponValid, HasPedGotWeapon, DoesWeaponTakeWeaponComponent,
   * clip sizes, drop-prop models) and report back.
   */
  InventoryCatalogAuditRequest: 'Roleplay:Net:Inventory:CatalogAuditRequest',

  /**
   * Client -> server. Result of the catalog sweep. Only accepted while
   * the server holds a pending audit for the Source; the server strips
   * the audit loadout and relays a summary to the requesting admin.
   */
  InventoryCatalogAuditReport: 'Roleplay:Net:Inventory:CatalogAuditReport',

  /**
   * Client -> server. Periodic self-report from the client anti-cheat
   * monitor, emitted every MonitorReportIntervalMs while spawned -
   * flagged or clean. The payload is HOSTILE tier-3 telemetry (a cheat
   * that kills the monitor kills the signal), so the server
   * typeof-validates every field, enforces a minimum arrival interval,
   * and throttles per detection before scoring. The cadence itself is
   * the heartbeat: a Source that stays spawned while the reports stop
   * past MonitorSilentThresholdMs is reported as MonitorSilent by the
   * server-side watchdog.
   */
  AnticheatMonitorReport: 'Roleplay:Net:Anticheat:MonitorReport',

  /**
   * Server -> client. `/ac test` (Founder-gated) instructs the issuer's
   * own client to simulate one cheat-shaped behaviour so the detection
   * pipeline can be exercised without cheat tooling: a replicated write
   * to a `Roleplay:` state-bag key (the tamper-watch canary), or a
   * temporary monitor silence (the heartbeat watchdog). The client
   * never initiates these on its own.
   */
  AnticheatTestDirective: 'Roleplay:Net:Anticheat:TestDirective',
} as const;

/** Any server<->client event name, derived from the constants object. */
export type NetEventName = (typeof NetEvents)[keyof typeof NetEvents];

/**
 * Payload contracts - keyed by NetEventName. Add an entry per event when
 * declaring it in the const map above. The type system then forces every
 * Trigger/Emit call site to send the right shape.
 */
export interface NetEventPayloads {
  [NetEvents.AuthInit]: {
    SpawnCoord: Vec3;
    Camera: CameraSpec;
    Bucket: number;
  };
  [NetEvents.AuthPrepared]: {
    DiscordID: string;
    DiscordDisplayName: string;
    DiscordAvatarURL: string | null;
  };
  [NetEvents.AuthFinalize]: Record<string, never>;
  [NetEvents.AuthSuccess]: {
    DiscordDisplayName: string;
    DiscordAvatarURL: string | null;
    /** Whether this account already owns at least one Active character. */
    HasCharacters: boolean;
    /** Resolved settings (defaults merged in); the SPA syncs its store. */
    Settings: AccountSettings;
  };
  [NetEvents.AuthFailure]: {
    Reason: string;
  };
  [NetEvents.CharacterCreate]: {
    FirstName: string;
    LastName: string;
    /** Player-entered numeric age (MinAge..MaxAge); server derives BirthDate. */
    Age: number;
    Gender: Gender;
    BloodType: BloodType;
    HeightCm: number;
    WeightKg: number;
    Appearance: AppearanceData;
    /**
     * Starting outfit captured on the wizard's final pages. Server inserts
     * one `character_outfits` row alongside the character itself, marked
     * IsActive=true and named "Default".
     */
    Outfit: OutfitData;
  };
  [NetEvents.CharacterCreateSuccess]: {
    CharacterID: string;
    SlotID: number;
    FirstName: string;
    LastName: string;
  };
  [NetEvents.CharacterCreateFailure]: {
    Reason: string;
  };
  [NetEvents.CharacterList]: Record<string, never>;
  [NetEvents.CharacterListResponse]: {
    Characters: CharacterSummary[];
  };
  [NetEvents.CharacterSelect]: {
    CharacterID: string;
  };
  [NetEvents.CharacterSpawned]: CharacterSpawnPayload;
  [NetEvents.CharacterSelectFailure]: {
    Reason: string;
  };
  [NetEvents.ChatPush]: {
    Body: string;
  };
  [NetEvents.ChatSubmit]: {
    Body: string;
  };
  [NetEvents.ChatClear]: Record<string, never>;
  [NetEvents.ChatCommandList]: {
    Commands: CommandHint[];
  };
  [NetEvents.ChatTypingState]: {
    On: boolean;
  };
  [NetEvents.SessionReturnToSelect]: Record<string, never>;
  [NetEvents.SessionReturnToAuth]: Record<string, never>;
  [NetEvents.SettingsUpdate]: {
    Settings: Partial<AccountSettings>;
  };
  [NetEvents.SettingsPushed]: {
    Settings: AccountSettings;
  };
  [NetEvents.ChatSettingChanged]: {
    /** Canonical key: `timestamp`, `chat`, `charactercounter`,
     * `selfnametag`, `nametagid`, `blindfold`, `fontsize`, `pagesize`. */
    Key: string;
    /** Resolved value. Boolean for toggle settings; number for
     * `fontsize` and `pagesize`. Server flipped the toggle and persisted
     * before emitting so the client just applies the result directly. */
    Value: boolean | number;
  };
  [NetEvents.InjuryHealthCritical]: Record<string, never>;
  [NetEvents.InjuryApply]: {
    /**
     * Character-column HP (0-100). Client offsets +100 for the GTA
     * native range. HP is the only ped stat that still round-trips:
     * armour writes moved server-side (SET_PED_ARMOUR is
     * apiset-server) while SET_ENTITY_HEALTH has no server variant.
     */
    HP: number;
    /** Optional teleport target. When supplied the client moves the ped and resets heading. */
    Teleport?: {
      X: number;
      Y: number;
      Z: number;
      Heading: number;
    };
  };
  [NetEvents.BleedingDrainTick]: {
    /**
     * Column-range HP delta (negative = loss). Applied as a relative
     * adjustment against the ped's current engine HP so a drain tick
     * composes with, rather than overwrites, concurrent damage.
     */
    HpDelta: number;
  };
  [NetEvents.InjuryRegenTick]: {
    /**
     * Column-range HP delta (positive = gain). Relative for the same
     * reason as the drain tick: a regen tick must compose with, never
     * overwrite, damage taken while the instruction was in flight.
     */
    HpDelta: number;
  };
  [NetEvents.AddictionWithdrawalTick]: {
    /** Column-range HP delta (negative = loss), floored client-side. */
    HpDelta: number;
  };
  [NetEvents.AdminNoClipToggle]: {
    On: boolean;
  };
  [NetEvents.InventoryDropRequest]: {
    SlotIndex: number;
    Quantity: number;
  };
  [NetEvents.InventoryPickupRequest]: {
    DropID: string;
  };
  [NetEvents.InventoryWeaponShot]: {
    /** Client-reported remaining ammo after the shot. Sizes the server's pop, clamped to the weapon's MaxBurstPerEvent; never trusted beyond that bound. */
    ExpectedRemainingAmmo: number;
    WeaponHash: number;
    /** Client clock at time of shot (GetGameTimer). Used for rate-limit cross-check, never trusted as truth. */
    Timestamp: number;
  };
  [NetEvents.InventoryWeaponReloadRequest]: Record<string, never>;
  [NetEvents.InventoryGroundDropSpawn]: {
    DropID: string;
    X: number;
    Y: number;
    Z: number;
    World: number;
    Label: string;
    Model: string;
    /** Weapon-component drops only. The client resolves the prop model
     *  from the engine (GetWeaponComponentTypeModel) - the catalog
     *  stores no model names for components - and falls back to the
     *  Model string when the engine carries none for this component. */
    ComponentHash?: number;
    /** Present only for catalog types with a WorldObjectRotation
     *  (decal-plane fixtures like the blood splat). The client applies
     *  it via SetEntityRotation after the prop spawns; absent = the
     *  engine's spawn rotation stands. Degrees. */
    Rotation?: { Pitch: number; Roll: number; Yaw: number };
  };
  [NetEvents.InventoryGroundDropDespawn]: {
    DropID: string;
  };
  [NetEvents.InventoryGroundDropResyncRequest]: Record<string, never>;
  [NetEvents.InventoryCatalogAuditRequest]: Record<string, never>;
  [NetEvents.InventoryCatalogAuditReport]: {
    CheckedWeapons: number;
    CheckedComponents: number;
    /** Components whose engine-resolved drop-prop model exists and streams. */
    ResolvedComponentModels: number;
    /** Weapon item IDs whose hash the engine does not recognise (IsWeaponValid false). */
    InvalidWeapons: string[];
    /** Weapon item IDs the engine knows but the ped did not receive from the server-side give. */
    MissingWeapons: string[];
    /** Component/weapon item ID pairs the engine refuses to combine. */
    ComponentRejections: { Component: string; Weapon: string }[];
    /** Informational: engine default clip size differs from the catalog MaxAmmo. */
    ClipSizeMismatches: { ID: string; Engine: number; Catalog: number }[];
    /** Weapon item IDs whose WorldObjectModel is not a valid streamable model. */
    InvalidDropModels: string[];
  };
  [NetEvents.AnticheatMonitorReport]: {
    /** Night-vision post-FX active (raw GetUsingnightvision read). */
    NightVision: boolean;
    /** Thermal-vision post-FX active (raw GetUsingseethrough read). */
    ThermalVision: boolean;
    /** Player-invincibility flag set (keep-ragdoll variant included)
     *  while the server has not sanctioned noclip. */
    ClientInvincibility: boolean;
    /** Rendered-cam distance from the ped in metres (one decimal) when
     *  the far-camera condition held two consecutive cycles; null when
     *  not flagged. */
    FreeCamDistance: number | null;
    /** Raw GetLocalPlayerAimState_2 value, sent every cycle as
     *  telemetry. 3 = free aim; 0/1/2 are the assisted modes
     *  (legitimate on controller input). */
    AimState: number;
    /** Assisted aim mode active while the input device read
     *  keyboard-and-mouse. Never set when the input-device native is
     *  unavailable - telemetry-only in that case. */
    AimAssistOn: boolean;
    /** Stamina still at max after 10+ continuous seconds of
     *  sprint-speed movement on foot. */
    InfiniteStamina: boolean;
    /** Clip ammo above the component-aware engine maximum for the
     *  equipped weapon. */
    OverMaxClip: boolean;
    /** Clip ammo sample when OverMaxClip is flagged; null otherwise. */
    ClipAmmo: number | null;
    /** Component-aware engine clip maximum when OverMaxClip is
     *  flagged; null otherwise. */
    ClipMax: number | null;
    /** CanPedRagdoll false on two consecutive cycles outside
     *  incapacitation and sanctioned noclip. */
    RagdollHack: boolean;
    /** Own-ped alpha below opaque or visibility off outside
     *  sanctioned noclip. */
    PedAlphaTampering: boolean;
    /** GetEntityAlpha sample when PedAlphaTampering is flagged; null
     *  otherwise. */
    PedAlpha: number | null;
  };
  [NetEvents.AnticheatTestDirective]: {
    /** Which simulation to run on the issuer's client. */
    Case: 'BagWrite' | 'MonitorSilence';
  };
}
