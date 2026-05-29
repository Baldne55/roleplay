import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { Parse, type ChatSegment, type CommandHint } from '@Shared/Chat/Index';

/**
 * Chat scrollback + input state.
 *
 *   Messages   - rolling buffer capped at 100. Each entry holds the raw
 *                token Body alongside the parsed Segments; the parser
 *                runs once on Push so render is cheap.
 *   History    - last 100 submitted lines; Up/Down navigates when the
 *                suggestion box is hidden.
 *   Commands   - last snapshot pushed by the server, drives the
 *                autocomplete suggestion box.
 *
 * Submit posts an NUI POST to the Frontend, which forwards it as a
 * ChatSubmit net event; the reply (if any) comes back as a ChatPush
 * the inbox routes here via Push.
 */
export interface ChatMessage {
  ID: number;
  Body: string;
  Segments: ChatSegment[];
}

const MessageCap = 100;
const HistoryCap = 100;
const InputMaxLength = 240;

export const useChatStore = defineStore('Chat', () => {
  const Messages = ref<ChatMessage[]>([]);
  const Commands = ref<CommandHint[]>([]);
  const InputActive = ref<boolean>(false);
  const Input = ref<string>('');
  const History = ref<string[]>([]);
  /**
   * -1 means "not navigating history" (the input is whatever the player
   * typed). 0..N points into History from oldest=0 ... newest=length-1.
   */
  const HistoryIndex = ref<number>(-1);
  let NextID = 1;

  const Suggestions = computed<CommandHint[]>(() => {
    const Raw = Input.value.trim();
    if (Raw.length === 0 || Raw[0] !== '/') return [];
    // Only suggest within the first word - once the player hits a space
    // they're typing args, not the command name.
    if (Raw.includes(' ')) return [];
    const Needle = Raw.slice(1).toLowerCase();
    if (Needle.length === 0) return Commands.value.slice(0, 8);
    const Matches: CommandHint[] = [];
    for (const Hint of Commands.value) {
      if (Hint.Name.toLowerCase().startsWith(Needle)) {
        Matches.push(Hint);
        continue;
      }
      for (const Alias of Hint.Aliases) {
        if (Alias.toLowerCase().startsWith(Needle)) {
          Matches.push(Hint);
          break;
        }
      }
      if (Matches.length >= 8) break;
    }
    return Matches.slice(0, 8);
  });

  function Push(Body: string): void {
    const Entry: ChatMessage = {
      ID: NextID++,
      Body,
      Segments: Parse(Body),
    };
    Messages.value.push(Entry);
    while (Messages.value.length > MessageCap) {
      Messages.value.shift();
    }
  }

  function Clear(): void {
    Messages.value = [];
  }

  function ShowInput(): void {
    if (InputActive.value) return;
    InputActive.value = true;
    HistoryIndex.value = -1;
  }

  function HideInput(): void {
    if (!InputActive.value) return;
    InputActive.value = false;
    Input.value = '';
    HistoryIndex.value = -1;
  }

  async function Submit(): Promise<void> {
    const Raw = Input.value.trim();
    if (Raw.length === 0) {
      HideInput();
      return;
    }
    const Truncated = Raw.length > InputMaxLength ? Raw.slice(0, InputMaxLength) : Raw;
    History.value.push(Truncated);
    while (History.value.length > HistoryCap) {
      History.value.shift();
    }
    HideInput();
    try {
      await fetch('https://roleplay/Chat:Submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: Truncated }),
      });
    } catch (Err: unknown) {
      // Surface as a local chat line so the player knows the bridge
      // dropped the submission - no server round-trip happened.
      Push(`(( !{#FF8080}ERROR:!{#FFFFFF} Chat bridge unavailable (${String(Err)}). ))`);
    }
  }

  /**
   * Step = -1 navigates to older history (Up key); +1 newer (Down).
   * No-op when History is empty.
   */
  function NavigateHistory(Step: -1 | 1): void {
    if (History.value.length === 0) return;
    if (HistoryIndex.value === -1) {
      // Entering history from a live input - jump to the most recent or
      // oldest depending on direction.
      HistoryIndex.value = Step === -1 ? History.value.length - 1 : 0;
    } else {
      HistoryIndex.value = Math.max(
        0,
        Math.min(History.value.length - 1, HistoryIndex.value + Step),
      );
    }
    Input.value = History.value[HistoryIndex.value] ?? '';
  }

  function SetCommands(List: CommandHint[]): void {
    Commands.value = List;
  }

  return {
    Messages,
    Commands,
    InputActive,
    Input,
    History,
    HistoryIndex,
    Suggestions,
    InputMaxLength,
    Push,
    Clear,
    ShowInput,
    HideInput,
    Submit,
    NavigateHistory,
    SetCommands,
  };
});
