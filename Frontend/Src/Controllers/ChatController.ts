import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { NUIEvents } from '@Shared/Events/NUIEvents.js';
import { NametagBagKeys } from '@Shared/Constants/Nametag.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';

declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, ...Args: unknown[]): void;
declare function RegisterCommand(
  Name: string,
  Handler: (Source: number, Args: string[], Raw: string) => void,
  Restricted: boolean,
): void;
declare function RegisterKeyMapping(
  CommandString: string,
  Description: string,
  DefaultMapper: string,
  DefaultParameter: string,
): void;
declare const LocalPlayer: {
  state: { set: (Key: string, Value: unknown, Replicated: boolean) => void };
};

/**
 * Frontend bridge for chat. Three concerns:
 *
 *   Server -> SPA: forward ChatPush / ChatClear / ChatCommandList net
 *   events into NUI messages.
 *
 *   SPA -> server: NUI callback 'Chat:Submit' wraps the raw input into
 *   the ChatSubmit net event; 'Chat:Focus' toggles SetNuiFocus.
 *
 *   T key: bound via RegisterCommand('+chat:focus') + RegisterKeyMapping
 *   so the player can open the input bar without us polling input. The
 *   SPA receives ChatShowInput and focuses its <input>.
 *
 *   IsSpawned gate: T-key + Chat:Submit are no-ops until the server
 *   confirms CharacterSpawned. Chat is read-only during the auth shell
 *   and the character flows; the welcome line and any system pushes
 *   still render, but the player can't open or send.
 */
export class ChatController {
  private readonly Log = Logger.New('Chat');
  private IsSpawned = false;

  constructor(private readonly Nui: NuiService) {
    onNet(
      NetEvents.ChatPush,
      (Payload: NetEventPayloads[typeof NetEvents.ChatPush]): void => {
        this.Nui.Send(NUIEvents.ChatPush, { Body: Payload.Body });
      },
    );

    onNet(NetEvents.ChatClear, (): void => {
      this.Nui.Send(NUIEvents.ChatClear, {});
    });

    onNet(
      NetEvents.ChatCommandList,
      (Payload: NetEventPayloads[typeof NetEvents.ChatCommandList]): void => {
        this.Nui.Send(NUIEvents.ChatCommandList, { Commands: Payload.Commands });
      },
    );

    onNet(
      NetEvents.ChatSettingChanged,
      (Payload: NetEventPayloads[typeof NetEvents.ChatSettingChanged]): void => {
        // Server already resolved the new value (toggle flipped, fontsize/
        // pagesize stored). Forward as-is; the SPA applies directly.
        this.Nui.Send(NUIEvents.ChatSettingChanged, {
          Key: Payload.Key,
          Value: Payload.Value,
        });
      },
    );

    onNet(NetEvents.CharacterSpawned, (): void => {
      this.IsSpawned = true;
    });

    // Mid-session exits (/changecharacter, /logout) put the player back
    // into a pre-spawn phase. Lock the input bar + T key until the next
    // CharacterSpawned re-arms them.
    onNet(NetEvents.SessionReturnToSelect, (): void => {
      this.IsSpawned = false;
    });
    onNet(NetEvents.SessionReturnToAuth, (): void => {
      this.IsSpawned = false;
    });

    this.Nui.OnCallback<{ Body: string }>('Chat:Submit', (Data): void => {
      if (!this.IsSpawned) return;
      const Body = typeof Data?.Body === 'string' ? Data.Body : '';
      if (Body.length === 0) return;
      const Payload: NetEventPayloads[typeof NetEvents.ChatSubmit] = { Body };
      emitNet(NetEvents.ChatSubmit, Payload);
    });

    this.Nui.OnCallback<{ On: boolean }>('Chat:Focus', (Data): void => {
      // Keyboard-only focus - cursor stays hidden. Movement keys are
      // suppressed by the engine while NUI has keyboard focus, which is
      // what we want for chat input.
      const On = Data?.On === true;
      this.Nui.Focus(On, false);
      // Mirror the focus into the replicated IsTyping bag so remote
      // clients can render the `[...]` typing indicator above this
      // player's nametag. The bag flips off the moment focus drops, so
      // the indicator never lingers past the actual input session.
      try {
        LocalPlayer.state.set(NametagBagKeys.IsTyping, On, true);
      } catch {
        // No state-bag surface in headless dev runs - silently ignore.
      }
    });

    RegisterCommand(
      '+chat:focus',
      (): void => {
        if (!this.IsSpawned) return;
        this.Nui.Send(NUIEvents.ChatShowInput, {});
      },
      false,
    );
    RegisterKeyMapping('+chat:focus', 'Open chat', 'KEYBOARD', 'T');

    this.Log.Debug('Handlers registered (T key bound to +chat:focus; gated on spawn)');
  }
}
