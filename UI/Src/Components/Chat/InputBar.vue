<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChatStore } from '@/Stores/Chat';
import SuggestionBox from '@/Components/Chat/SuggestionBox.vue';

const Chat = useChatStore();
const InputEl = ref<HTMLInputElement | null>(null);
const HighlightIndex = ref<number>(0);

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

function HandleEnter(): void {
  // Enter always submits. Tab is the only key that applies a suggestion -
  // otherwise typing the full command name (e.g. /help) would have Enter
  // overwriting the buffer with the same name instead of sending.
  void Chat.Submit();
}

function HandleEscape(): void {
  Chat.HideInput();
}

function HandleTab(): void {
  if (Chat.Suggestions.length === 0) return;
  ApplySuggestion();
}

function ApplySuggestion(): void {
  const Hint = Chat.Suggestions[HighlightIndex.value];
  if (Hint === undefined) return;
  // No trailing space - the player can decide whether the command takes
  // args, and adding one forced an extra Backspace for arg-less commands.
  Chat.Input = `/${Hint.Name}`;
  HighlightIndex.value = 0;
  FocusInput();
}

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

function HandlePageUp(): void {
  Chat.RequestScroll(-1);
}

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
      />
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
