<!--
  The chat draft line: text field, character counter, and the autocomplete
  dropdown it owns the selection state for.

  Mounted only while `Chat.InputActive` (see ChatRoot), which makes the
  mount/unmount pair the natural place to move NUI focus. On mount it
  POSTs `Chat:Focus {On: true}`, which has the client call SetNuiFocus so
  keystrokes reach this field instead of the game; on unmount it posts
  `{On: false}` to hand control back. Those two must stay balanced - a
  path that tears the component down without the unmount hook running
  leaves the player focused into a dead browser with no way to move or
  reopen chat short of a reconnect. Every dismissal therefore routes
  through `Chat.HideInput()` rather than unmounting the component directly.

  Key handling, all `.prevent` so the game never also sees the keystroke:

    Enter      submit (never applies a suggestion - see HandleEnter)
    Tab        apply the highlighted suggestion
    Esc        cancel and close
    Up/Down    history when a recall is active, else suggestion navigation
    PgUp/PgDn  scroll the message list

  `HighlightIndex` lives here rather than in the store or in SuggestionBox
  because this component owns the arrow keys that move it; the dropdown
  below is pure presentation and receives it as a prop. Two watchers keep
  it in range as the suggestion list changes underneath it.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { UseChatStore } from '@/Stores/Chat';
import SuggestionBox from '@/Components/Chat/SuggestionBox.vue';

const Chat = UseChatStore();
/** The text field, for programmatic refocus after applying a suggestion. */
const InputEl = ref<HTMLInputElement | null>(null);
/** Selected suggestion row. Owned here because this component owns the arrow keys. */
const HighlightIndex = ref<number>(0);

/** Characters left before the server-side cap; the counter turns amber near zero. */
const RemainingChars = computed<number>(() => Chat.InputMaxLength - Chat.Input.length);

watch(
  () => Chat.Suggestions.length,
  () => {
    if (HighlightIndex.value >= Chat.Suggestions.length) {
      HighlightIndex.value = Math.max(0, Chat.Suggestions.length - 1);
    }
  },
);

watch(
  () => Chat.Input,
  () => {
    // Reset highlight to the first match each time the input changes;
    // arrow navigation walks within the current suggestion window.
    HighlightIndex.value = 0;
  },
);

/**
 * Focus the field on the next tick, once Vue has flushed - focusing
 * synchronously can target an element that is about to be re-rendered.
 * `preventScroll` stops the overlay jumping.
 */
function FocusInput(): void {
  void nextTick(() => {
    InputEl.value?.focus({ preventScroll: true });
  });
}

onMounted(() => {
  void fetch('https://roleplay/Chat:Focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ On: true }),
  });
  FocusInput();
});

onBeforeUnmount(() => {
  void fetch('https://roleplay/Chat:Focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ On: false }),
  });
});

/** Submit the draft. Never applies a suggestion - see the inline note. */
function HandleEnter(): void {
  // Enter always submits. Tab is the only key that applies a suggestion -
  // otherwise typing the full command name (e.g. /help) would have Enter
  // overwriting the buffer with the same name instead of sending.
  void Chat.Submit();
}

/**
 * Cancel and close. Routes through the store rather than unmounting
 * directly, so the NUI focus handshake in this component's unmount hook
 * always runs - see the header.
 */
function HandleEscape(): void {
  Chat.HideInput();
}

/** Apply the highlighted suggestion; no-ops when the list is empty. */
function HandleTab(): void {
  if (Chat.Suggestions.length === 0) return;
  ApplySuggestion();
}

/**
 * Replace the draft with the highlighted command name and refocus.
 * Deliberately adds no trailing space - see the inline note.
 */
function ApplySuggestion(): void {
  const Hint = Chat.Suggestions[HighlightIndex.value];
  if (Hint === undefined) return;
  // No trailing space - the player can decide whether the command takes
  // args, and adding one forced an extra Backspace for arg-less commands.
  Chat.Input = `/${Hint.Name}`;
  HighlightIndex.value = 0;
  FocusInput();
}

/**
 * Up: history when a recall is already active, otherwise suggestion
 * navigation, falling back to history when there are no suggestions. The
 * precedence is what stops the keys flipping meaning mid-recall - see the
 * inline note.
 */
function HandleUp(): void {
  // Once the player has stepped into history mode (a recall is on
  // screen) arrow keys keep navigating history regardless of whether
  // the recalled string starts with `/` and triggers the suggestion
  // box - otherwise UP would silently flip to scrolling suggestions
  // after the first recall.
  if (Chat.HistoryIndex !== -1) {
    Chat.NavigateHistory(-1);
    return;
  }
  if (Chat.Suggestions.length > 0) {
    HighlightIndex.value = Math.max(0, HighlightIndex.value - 1);
    return;
  }
  Chat.NavigateHistory(-1);
}

/** Down: the mirror of HandleUp, with the same precedence rules. */
function HandleDown(): void {
  if (Chat.HistoryIndex !== -1) {
    Chat.NavigateHistory(1);
    return;
  }
  if (Chat.Suggestions.length > 0) {
    HighlightIndex.value = Math.min(Chat.Suggestions.length - 1, HighlightIndex.value + 1);
    return;
  }
  Chat.NavigateHistory(1);
}

/** Scroll the message list up one window, via the store's counter. */
function HandlePageUp(): void {
  Chat.RequestScroll(-1);
}

/** Scroll the message list down one window. */
function HandlePageDown(): void {
  Chat.RequestScroll(1);
}
</script>

<template>
  <div class="Chat-Input">
    <div class="Chat-Input-Row">
      <input
        ref="InputEl"
        v-model="Chat.Input"
        type="text"
        :maxlength="Chat.InputMaxLength"
        placeholder="Type a command, press Enter to send, Esc to cancel"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        @keydown.enter.prevent="HandleEnter"
        @keydown.esc.prevent="HandleEscape"
        @keydown.tab.prevent="HandleTab"
        @keydown.up.prevent="HandleUp"
        @keydown.down.prevent="HandleDown"
        @keydown.page-up.prevent="HandlePageUp"
        @keydown.page-down.prevent="HandlePageDown"
      >
      <span
        v-if="Chat.CharacterCounterVisible"
        class="Chat-Counter"
        :class="{ Low: RemainingChars < 30 }"
      >
        {{ RemainingChars }}
      </span>
    </div>
    <SuggestionBox :HighlightIndex="HighlightIndex" />
  </div>
</template>

<style scoped>
.Chat-Input {
  background: rgba(0, 0, 0, 0.65);
}

.Chat-Input-Row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
}

input {
  flex: 1 1 auto;
  background: transparent;
  border: none;
  outline: none;
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 500;
}

input::placeholder {
  color: rgba(255, 255, 255, 0.55);
}

.Chat-Counter {
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.85rem;
  min-width: 2.5rem;
  text-align: right;
}

.Chat-Counter.Low {
  color: #ffb07a;
}
</style>
