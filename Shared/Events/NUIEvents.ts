/**
 * NUI events - Frontend <-> UI channel.
 *
 * Local in-process bridge between the FiveM client (JS V8) and the CEF
 * browser running the Vue SPA (SendNUIMessage / RegisterNUICallback).
 * No untrusted transport - but payloads are still typed.
 *
 * Format: `Roleplay:NUI:<Domain>:<VerbNoun>` (PascalCase, all-caps acronyms).
 *
 * Convention: every payload carries a literal `Type` field equal to the
 * event name. The UI inbox reads `Type` to dispatch; this lets us put the
 * full message on the window.message bus without per-channel listeners.
 */

import type { CharacterSummary } from '../Constants/Character.js';
import type { AccountSettings } from '../Constants/AccountSettings.js';
import type { CommandHint } from '../Chat/Index.js';

export const NUIEvents = {
  /**
   * Frontend -> UI. Tells the SPA to show the auth card (routes to /Auth).
   * Sent once the skybox shell is mounted and the cinematic camera is live.
   */
  AuthShow: 'Roleplay:NUI:Auth:Show',

  /**
   * Frontend -> UI. Discord identity resolved on the server side;
   * carries the profile preview so the card can render "Welcome,
   * {DisplayName}" + avatar before the player clicks Enter.
   */
  AuthPrepared: 'Roleplay:NUI:Auth:Prepared',

  /**
   * Frontend -> UI. OAuth completed successfully; UI should route to
   * the post-auth view.
   */
  AuthCompleted: 'Roleplay:NUI:Auth:Completed',

  /**
   * Frontend -> UI. Finalize failed (e.g. transient DB error); UI clears
   * loading state and surfaces the reason inline. Hard gate failures
   * (no Discord, not in guild) kick the player and never reach the UI.
   */
  AuthFailed: 'Roleplay:NUI:Auth:Failed',

  /**
   * Frontend -> UI. Push the SPA into the character-creation flow.
   * Fired after AuthSuccess for accounts with zero Active characters.
   * UI lands on /Character/Details.
   */
  CharacterShowCreate: 'Roleplay:NUI:Character:ShowCreate',

  /**
   * Frontend -> UI. Server accepted the create submission and the row
   * is persisted. UI clears the in-progress form / appearance; the
   * server is already auto-spawning the new character via
   * CharacterSpawned, so no route change is needed.
   */
  CharacterCreated: 'Roleplay:NUI:Character:Created',

  /**
   * Frontend -> UI. Server rejected the create submission. UI clears
   * the loading state, surfaces Reason on whichever step is offending
   * (Details for validation errors; Overlays page if forensic / row
   * failure).
   */
  CharacterCreateFailed: 'Roleplay:NUI:Character:CreateFailed',

  /**
   * Frontend -> UI. Runtime drawable / texture bounds for the outfit
   * sliders. Sent once on StartPreview after the freemode model loads;
   * the UI seeds the per-category Drawable / Texture slider maxima from
   * this payload. Categories are keyed by `ClothingCategory.Id`.
   */
  OutfitBounds: 'Roleplay:NUI:Outfit:Bounds',

  /**
   * Frontend -> UI. Push the SPA into the character-selector flow.
   * Fired after AuthSuccess for accounts with at least one Active
   * character. UI lands on /Character/Select.
   */
  CharacterShowSelect: 'Roleplay:NUI:Character:ShowSelect',

  /**
   * Frontend -> UI. Server returned the character list. UI store
   * absorbs the array; the selector view re-renders.
   */
  CharacterListLoaded: 'Roleplay:NUI:Character:ListLoaded',

  /**
   * Frontend -> UI. Selector accepted the player's pick (or the post-
   * Create flow is auto-spawning). UI fades out and routes to /InWorld;
   * actual ped placement happens on the Frontend side in parallel.
   */
  CharacterSpawning: 'Roleplay:NUI:Character:Spawning',

  /**
   * Frontend -> UI. Server rejected the select request. UI stays on
   * the selector and surfaces Reason inline.
   */
  CharacterSelectFailed: 'Roleplay:NUI:Character:SelectFailed',

  /**
   * Frontend -> UI. Append a chat line. Body is a token-formatted
   * string; the SPA parses it into Segments before storing.
   */
  ChatPush: 'Roleplay:NUI:Chat:Push',

  /**
   * Frontend -> UI. Wipe the local scrollback (forward-compat surface
   * for /clearchat). No producer in this slice.
   */
  ChatClear: 'Roleplay:NUI:Chat:Clear',

  /**
   * Frontend -> UI. Player pressed the chat-open key; SPA focuses the
   * input bar. Focus state (SetNuiFocus) is mediated by the SPA via
   * the Chat:Focus NUI callback on mount / unmount.
   */
  ChatShowInput: 'Roleplay:NUI:Chat:ShowInput',

  /**
   * Frontend -> UI. Forwarded command snapshot pushed after spawn -
   * powers slash autocomplete.
   */
  ChatCommandList: 'Roleplay:NUI:Chat:CommandList',

  /**
   * Frontend -> UI. Player ran /changecharacter from chat. SPA resets
   * the character list store so the selector re-fetches on mount, marks
   * the chat scrollback as read-only, and routes to /Character/Select.
   */
  SessionReturnToSelect: 'Roleplay:NUI:Session:ReturnToSelect',

  /**
   * Frontend -> UI. Player ran /logout from chat. SPA flips the Auth
   * store back to its Prepared state (Discord identity still resolved,
   * Enter Server clickable), resets the character list, and routes to
   * /Auth.
   */
  SessionReturnToAuth: 'Roleplay:NUI:Session:ReturnToAuth',

  /**
   * Frontend -> UI. Latest resolved settings - sent on AuthCompleted
   * (initial hydrate) and again after a SettingsUpdate round-trip
   * (server echo). UI store overwrites its state on every push.
   */
  SettingsHydrate: 'Roleplay:NUI:Settings:Hydrate',

  /**
   * Frontend -> UI. Server-side /toggle / /fontsize / /pagesize
   * command landed; SPA flips or updates the matching chat-UI knob.
   */
  ChatSettingChanged: 'Roleplay:NUI:Chat:SettingChanged',
} as const;

export type NUIEventName = (typeof NUIEvents)[keyof typeof NUIEvents];

export interface NUIEventPayloads {
  [NUIEvents.AuthShow]: {
    Type: typeof NUIEvents.AuthShow;
  };
  [NUIEvents.AuthPrepared]: {
    Type: typeof NUIEvents.AuthPrepared;
    DiscordDisplayName: string;
    DiscordAvatarURL: string | null;
  };
  [NUIEvents.AuthCompleted]: {
    Type: typeof NUIEvents.AuthCompleted;
    DiscordDisplayName: string;
    DiscordAvatarURL: string | null;
    HasCharacters: boolean;
    Settings: AccountSettings;
  };
  [NUIEvents.AuthFailed]: {
    Type: typeof NUIEvents.AuthFailed;
    Reason: string;
  };
  [NUIEvents.CharacterShowCreate]: {
    Type: typeof NUIEvents.CharacterShowCreate;
  };
  [NUIEvents.CharacterCreated]: {
    Type: typeof NUIEvents.CharacterCreated;
    CharacterID: string;
    SlotID: number;
    FirstName: string;
    LastName: string;
  };
  [NUIEvents.CharacterCreateFailed]: {
    Type: typeof NUIEvents.CharacterCreateFailed;
    Reason: string;
  };
  [NUIEvents.OutfitBounds]: {
    Type: typeof NUIEvents.OutfitBounds;
    /**
     * Per-category bounds keyed by ClothingCategory.Id.
     *
     *   DrawableMax            - GetNumberOfPed{Component,Prop}Variations - 1
     *   TextureMaxByDrawable[i] - GetNumberOfPed{Component,Prop}TextureVariations(i) - 1
     *
     * The UI clamps Drawable to [Min, DrawableMax] (Min is -1 for props,
     * 0 for components) and Texture to [0, TextureMaxByDrawable[Drawable]].
     */
    Categories: Record<string, { DrawableMax: number; TextureMaxByDrawable: number[] }>;
  };
  [NUIEvents.CharacterShowSelect]: {
    Type: typeof NUIEvents.CharacterShowSelect;
  };
  [NUIEvents.CharacterListLoaded]: {
    Type: typeof NUIEvents.CharacterListLoaded;
    Characters: CharacterSummary[];
  };
  [NUIEvents.CharacterSpawning]: {
    Type: typeof NUIEvents.CharacterSpawning;
  };
  [NUIEvents.CharacterSelectFailed]: {
    Type: typeof NUIEvents.CharacterSelectFailed;
    Reason: string;
  };
  [NUIEvents.ChatPush]: {
    Type: typeof NUIEvents.ChatPush;
    Body: string;
  };
  [NUIEvents.ChatClear]: {
    Type: typeof NUIEvents.ChatClear;
  };
  [NUIEvents.ChatShowInput]: {
    Type: typeof NUIEvents.ChatShowInput;
  };
  [NUIEvents.ChatCommandList]: {
    Type: typeof NUIEvents.ChatCommandList;
    Commands: CommandHint[];
  };
  [NUIEvents.SessionReturnToSelect]: {
    Type: typeof NUIEvents.SessionReturnToSelect;
  };
  [NUIEvents.SessionReturnToAuth]: {
    Type: typeof NUIEvents.SessionReturnToAuth;
  };
  [NUIEvents.SettingsHydrate]: {
    Type: typeof NUIEvents.SettingsHydrate;
    Settings: AccountSettings;
  };
  [NUIEvents.ChatSettingChanged]: {
    Type: typeof NUIEvents.ChatSettingChanged;
    Key: string;
    Value: boolean | number;
  };
}

/** Discriminated union of every NUI message the SPA might receive. */
export type NUIMessage = NUIEventPayloads[NUIEventName];
