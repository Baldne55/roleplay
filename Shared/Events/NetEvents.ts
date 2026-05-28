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
}
