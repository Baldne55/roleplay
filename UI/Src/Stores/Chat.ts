import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ChatBodyMaxLength, Parse, type ChatSegment, type CommandHint } from '@Shared/Chat/Index';

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
  /** Local-clock millisecond Date.now() captured when the line was
   * received. Rendered as `[HH:MM:SS]` when TimestampVisible is on. */
  ReceivedAt: number;
}

/**
 * Scrollback ceiling. Oldest lines are dropped past this - the SPA runs
 * inside CEF alongside the game, so an unbounded array is a memory leak
 * measured against the player's frame budget, not a desktop browser's.
 */
const MessageCap = 100;
/** Up-arrow input history depth. Independent of MessageCap despite the same value. */
const HistoryCap = 100;
/**
 * Re-exported from Shared so the input's cap and the Backend's arrival
 * check are one number. They used to be independent 240s in two
 * workspaces.
 */
const InputMaxLength = ChatBodyMaxLength;
/**
 * Fallbacks matching the /fontsize and /pagesize command defaults. Used
 * only until the server's settings hydrate arrives; they must stay in
 * step with DefaultAccountSettings or the overlay visibly re-flows a
 * moment after connecting.
 */
const FontSizeDefault = 0.65;
const PageSizeDefault = 20;

/**
 * Chat overlay state: scrollback, input buffer, command hints, and the
 * display preferences the server pushes down.
 *
 * The store holds already-parsed Segments rather than raw token strings,
 * so colour parsing happens once on arrival instead of on every re-render
 * - and, more importantly, so no component is ever handed a string it
 * might be tempted to render as HTML.
 */
export const UseChatStore = defineStore('Chat', () => {
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

  // ── Per-player chat UI knobs ─────────────────────────────────────
  // Toggled by /toggle, /fontsize, /pagesize and pushed via the
  // ChatSettingChanged net event. Local-only state; not persisted.
  const TimestampVisible = ref<boolean>(false);
  const ChatVisible = ref<boolean>(true);
  const CharacterCounterVisible = ref<boolean>(true);
  const BlindfoldOn = ref<boolean>(false);
  const FontSize = ref<number>(FontSizeDefault);
  const PageSize = ref<number>(PageSizeDefault);

  /**
   * Monotonic scroll-request counter. InputBar bumps it on PageUp /
   * PageDown; MessageList watches and scrolls by one visible window
   * (its own clientHeight, which PageSize sizes via CSS). A counter
   * rather than a boolean so back-to-back PageUp presses all register
   * even when the direction does not change.
   */
  const ScrollDirection = ref<-1 | 1>(-1);
  const ScrollCounter = ref<number>(0);
  function RequestScroll(Direction: -1 | 1): void {
    ScrollDirection.value = Direction;
    ScrollCounter.value += 1;
  }

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
      } else if (Hint.Aliases.some((Alias) => Alias.toLowerCase().startsWith(Needle))) {
        Matches.push(Hint);
      }
      // Checked after BOTH match paths - a `continue` on the name branch
      // used to skip this, so a name-matched query walked the whole
      // command list on every keystroke instead of stopping at the cap.
      if (Matches.length >= 8) break;
    }
    return Matches;
  });

  function Push(Body: string): void {
    const Entry: ChatMessage = {
      ID: NextID++,
      Body,
      Segments: Parse(Body),
      ReceivedAt: Date.now(),
    };
    Messages.value.push(Entry);
    while (Messages.value.length > MessageCap) {
      Messages.value.shift();
    }
  }

  /**
   * Apply a /toggle, /fontsize or /pagesize push from the server. The
   * server pre-resolved the new value (flipping was done server-side so
   * the persisted state matches), so we set directly rather than flip.
   * Unknown keys are ignored so the server can introduce new keys
   * without breaking older UI builds.
   */
  function ApplySetting(Key: string, Value: boolean | number): void {
    switch (Key) {
      case 'timestamp':
        if (typeof Value === 'boolean') TimestampVisible.value = Value;
        return;
      case 'chat':
        if (typeof Value === 'boolean') ChatVisible.value = Value;
        return;
      case 'charactercounter':
        if (typeof Value === 'boolean') CharacterCounterVisible.value = Value;
        return;
      case 'blindfold':
        if (typeof Value === 'boolean') BlindfoldOn.value = Value;
        return;
      case 'fontsize':
        if (typeof Value === 'number' && Number.isFinite(Value)) {
          FontSize.value = Value;
        }
        return;
      case 'pagesize':
        if (typeof Value === 'number' && Number.isFinite(Value)) {
          PageSize.value = Value;
        }
        return;
      default:
        // selfnametag / nametagid land here today; no overlay yet.
        return;
    }
  }

  /**
   * Bulk-apply chat-related settings from an AccountSettings hydrate.
   * Used by the Settings store on AuthCompleted so the UI is in its
   * persisted state before the first message lands.
   */
  function HydrateFrom(Settings: {
    ChatTimestamp?: boolean;
    ChatVisible?: boolean;
    ChatCharacterCounter?: boolean;
    ChatBlindfold?: boolean;
    ChatFontSize?: number;
    ChatPageSize?: number;
  }): void {
    if (typeof Settings.ChatTimestamp === 'boolean') {
      TimestampVisible.value = Settings.ChatTimestamp;
    }
    if (typeof Settings.ChatVisible === 'boolean') {
      ChatVisible.value = Settings.ChatVisible;
    }
    if (typeof Settings.ChatCharacterCounter === 'boolean') {
      CharacterCounterVisible.value = Settings.ChatCharacterCounter;
    }
    if (typeof Settings.ChatBlindfold === 'boolean') {
      BlindfoldOn.value = Settings.ChatBlindfold;
    }
    if (typeof Settings.ChatFontSize === 'number') {
      FontSize.value = Settings.ChatFontSize;
    }
    if (typeof Settings.ChatPageSize === 'number') {
      PageSize.value = Settings.ChatPageSize;
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
   *
   *   - Up from a live (non-history) input -> most recent submission.
   *     Down from a live input is a no-op (you can't go newer than
   *     fresh).
   *   - Stepping past the newest entry exits history mode and empties
   *     the input - the player is back in "fresh typing" mode and
   *     suggestions can take over again.
   *   - Up at the oldest entry clamps in place.
   *
   * Matches the bash / readline convention every player has muscle
   * memory for. No-op when History is empty.
   */
  function NavigateHistory(Step: -1 | 1): void {
    if (History.value.length === 0) return;
    if (HistoryIndex.value === -1) {
      if (Step === 1) return; // Down from fresh input: nothing newer to recall.
      HistoryIndex.value = History.value.length - 1;
      Input.value = History.value[HistoryIndex.value] ?? '';
      return;
    }
    const Next = HistoryIndex.value + Step;
    if (Next > History.value.length - 1) {
      // Down past the newest entry: drop out of history mode, blank
      // the buffer so the next Down is a no-op.
      HistoryIndex.value = -1;
      Input.value = '';
      return;
    }
    HistoryIndex.value = Math.max(0, Next);
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
    TimestampVisible,
    ChatVisible,
    CharacterCounterVisible,
    BlindfoldOn,
    FontSize,
    PageSize,
    ScrollDirection,
    ScrollCounter,
    Push,
    Clear,
    ShowInput,
    HideInput,
    Submit,
    NavigateHistory,
    SetCommands,
    ApplySetting,
    HydrateFrom,
    RequestScroll,
  };
});
