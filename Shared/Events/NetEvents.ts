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
   * Server -> client. /noclip flipped this admin's free-fly state.
   * Targets the issuer only; the server keeps the on/off set as the
   * source of truth so a reconnect-while-noclipping or a duplicate
   * /noclip can not desync state. The client toggles ped visibility,
   * collision, freeze, and the per-frame camera-relative movement
   * tick based on `On`.
   */
  AdminNoClipToggle: 'Roleplay:Net:Admin:NoClipToggle',
} as const;

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
    /** Character-column HP (0-100). Client offsets +100 for the GTA native range. */
    HP: number;
    /** Optional armour reset value; omit to leave armour untouched. */
    AP?: number;
    /** Optional teleport target. When supplied the client moves the ped and resets heading. */
    Teleport?: {
      X: number;
      Y: number;
      Z: number;
      Heading: number;
    };
  };
  [NetEvents.AdminNoClipToggle]: {
    On: boolean;
  };
}
