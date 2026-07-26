import type { Router } from 'vue-router';
import { NUIEvents, type NUIMessage } from '@Shared/Events/NUIEvents.js';
import { UseAuthStore } from '@/Stores/Auth';
import { UseCharacterStore } from '@/Stores/Character';
import { UseCharacterListStore } from '@/Stores/CharacterList';
import { UseChatStore } from '@/Stores/Chat';
import { UseSettingsStore } from '@/Stores/Settings';

/**
 * Reads incoming SendNUIMessage payloads from the Frontend (client-side
 * FiveM script) off the window.message bus and dispatches them.
 *
 *   AuthShow              -> push /Auth route
 *   AuthPrepared          -> store profile preview; card renders welcome
 *   AuthCompleted         -> store final profile; HasCharacters -> /Character/Select
 *                            else -> /Character/Details
 *   AuthFailed            -> store reason; card surfaces it inline
 *   CharacterShowCreate   -> route to /Character/Details
 *   CharacterShowSelect   -> route to /Character/Select
 *   CharacterCreated      -> reset wizard store; no route change (the
 *                            server is already auto-spawning the new
 *                            character via CharacterSpawned)
 *   CharacterCreateFailed -> wizard store records the failure
 *   CharacterListLoaded   -> populate list store
 *   CharacterSpawning     -> route to /InWorld (SPA goes invisible)
 *   CharacterSelectFailed -> list store records the failure
 *   OutfitBounds          -> wizard store seeds slider maxima
 */
export class NuiInbox {
  constructor(private readonly RouterInstance: Router) {}

  /** Begin listening for NUI messages. Idempotent. */
  Start(): void {
    window.addEventListener('message', this.HandleWindowMessage);
  }

  /** Detach the listener. Idempotent. */
  Stop(): void {
    window.removeEventListener('message', this.HandleWindowMessage);
  }

  /**
   * Receive one `window.message` from the Frontend and dispatch it.
   *
   * Arrow-function field so `this` stays bound across
   * addEventListener/removeEventListener - a method reference would not
   * detach correctly on Stop().
   *
   * Normalises the payload, then admits it only if the type guard
   * recognises its `Type`. Everything else is discarded: the NUI window
   * shares an origin with anything that can post to it, so the allow-list
   * is what keeps a foreign message out of a store mutation.
   */
  private HandleWindowMessage = (RawEvent: MessageEvent<unknown>): void => {
    const Data = NormaliseEventData(RawEvent.data);
    if (!IsNuiMessage(Data)) return;

    const Auth = UseAuthStore();

    switch (Data.Type) {
      case NUIEvents.AuthShow:
        this.RouterInstance.replace('/Auth').catch((Err: unknown) => {
          console.error('[NuiInbox] /Auth navigation failed', Err);
        });
        return;
      case NUIEvents.AuthPrepared:
        Auth.HandlePrepared(Data.DiscordDisplayName, Data.DiscordAvatarURL);
        return;
      case NUIEvents.AuthCompleted: {
        Auth.HandleSuccess(Data.DiscordDisplayName, Data.DiscordAvatarURL, Data.HasCharacters);
        // Server-side settings snapshot wins over the localStorage cache;
        // hydrate before the next view renders so the theme picker shows
        // the persisted choice.
        const Settings = UseSettingsStore();
        Settings.Hydrate(Data.Settings);
        // Existing characters go straight to the selector; zero-character
        // accounts fall through to the create flow.
        const Target = Data.HasCharacters ? '/Character/Select' : '/Character/Details';
        this.RouterInstance.replace(Target).catch((Err: unknown) => {
          console.error(`[NuiInbox] ${Target} navigation failed`, Err);
        });
        return;
      }
      case NUIEvents.AuthFailed:
        Auth.HandleFailure(Data.Reason);
        return;
      case NUIEvents.CharacterShowCreate:
        this.RouterInstance.replace('/Character/Details').catch((Err: unknown) => {
          console.error('[NuiInbox] /Character/Details navigation failed', Err);
        });
        return;
      case NUIEvents.CharacterShowSelect:
        this.RouterInstance.replace('/Character/Select').catch((Err: unknown) => {
          console.error('[NuiInbox] /Character/Select navigation failed', Err);
        });
        return;
      case NUIEvents.CharacterCreated: {
        // Server accepted + auto-spawn is en route via CharacterSpawned.
        // Flip the wizard status to 'Spawned' so CreatorView's
        // onBeforeUnmount (which fires when /InWorld replaces the route)
        // SKIPS its StopPreview teardown - without this the freshly-
        // spawned ped gets teleported back to the auth skybox by
        // RestoreAuthShell.
        const Character = UseCharacterStore();
        Character.MarkSpawned();
        return;
      }
      case NUIEvents.CharacterCreateFailed: {
        const Character = UseCharacterStore();
        Character.HandleFailure(Data.Reason);
        return;
      }
      case NUIEvents.CharacterListLoaded: {
        const List = UseCharacterListStore();
        List.ReceiveList(Data.Characters);
        return;
      }
      case NUIEvents.CharacterSpawning: {
        // Server confirmed the spawn handoff; UI gets out of the way.
        const List = UseCharacterListStore();
        List.Reset();
        this.RouterInstance.replace('/InWorld').catch((Err: unknown) => {
          console.error('[NuiInbox] /InWorld navigation failed', Err);
        });
        return;
      }
      case NUIEvents.CharacterSelectFailed: {
        const List = UseCharacterListStore();
        List.HandleFailure(Data.Reason);
        return;
      }
      case NUIEvents.OutfitBounds: {
        const Character = UseCharacterStore();
        Character.SetOutfitBounds(Data.Categories);
        return;
      }
      case NUIEvents.ChatPush: {
        const Chat = UseChatStore();
        Chat.Push(Data.Body);
        return;
      }
      case NUIEvents.ChatClear: {
        const Chat = UseChatStore();
        Chat.Clear();
        return;
      }
      case NUIEvents.ChatShowInput: {
        const Chat = UseChatStore();
        Chat.ShowInput();
        return;
      }
      case NUIEvents.ChatCommandList: {
        const Chat = UseChatStore();
        Chat.SetCommands(Data.Commands);
        return;
      }
      case NUIEvents.ChatSettingChanged: {
        const Chat = UseChatStore();
        Chat.ApplySetting(Data.Key, Data.Value);
        return;
      }
      case NUIEvents.SettingsHydrate: {
        const Settings = UseSettingsStore();
        Settings.Hydrate(Data.Settings);
        return;
      }
      case NUIEvents.SessionReturnToSelect: {
        // /changecharacter: the spawned character is gone server-side;
        // reset the list store so the selector re-fetches on mount and
        // route back. Auth state is preserved (the player is still
        // signed in).
        const List = UseCharacterListStore();
        List.Reset();
        this.RouterInstance.replace('/Character/Select').catch((Err: unknown) => {
          console.error('[NuiInbox] /Character/Select navigation failed', Err);
        });
        return;
      }
      case NUIEvents.SessionReturnToAuth: {
        // /logout: rewind to the post-Prepared auth state so the Enter
        // Server button is clickable again, then route back.
        Auth.ResetForReturn();
        const List = UseCharacterListStore();
        List.Reset();
        this.RouterInstance.replace('/Auth').catch((Err: unknown) => {
          console.error('[NuiInbox] /Auth navigation failed', Err);
        });
        return;
      }
      default: {
        const _Unhandled: never = Data;
        void _Unhandled;
      }
    }
  };
}

/**
 * Unwrap a NUI message body that arrived as a JSON string.
 *
 * The CEF bridge sometimes delivers the payload already parsed and
 * sometimes as a string, depending on how it was posted. Only strings
 * that actually look like an object are parsed, and a parse failure
 * returns the original value rather than throwing - a malformed message
 * should be dropped by the type guard below, not crash the listener.
 */
function NormaliseEventData(Value: unknown): unknown {
  if (typeof Value !== 'string') return Value;
  const Trimmed = Value.trim();
  if (Trimmed.length === 0 || Trimmed[0] !== '{') return Value;
  try {
    return JSON.parse(Trimmed);
  } catch {
    return Value;
  }
}

/**
 * Type guard admitting only messages whose `Type` is a known NUI event.
 *
 * This is the browser's trust boundary. The NUI window shares an origin
 * with any other resource that can post to it, so an unrecognised `Type`
 * is discarded rather than dispatched - the allow-list is what stops a
 * foreign message reaching a store mutation.
 */
function IsNuiMessage(Value: unknown): Value is NUIMessage {
  if (typeof Value !== 'object' || Value === null) return false;
  const Type = (Value as { Type?: unknown }).Type;
  if (typeof Type !== 'string') return false;
  const Known: readonly string[] = Object.values(NUIEvents);
  return Known.includes(Type);
}
