<!--
  Command autocomplete dropdown, shown above the input bar while the
  player is typing a `/command`.

  Renders `Chat.Suggestions`, which the store recomputes as the draft
  changes by filtering the command list the server pushed at spawn
  (ChatCommandList -> Chat.SetCommands). The list is therefore already
  permission-filtered server-side: a player never sees a suggestion for a
  command their staff level cannot run, because the server never sent it.

  Selection state lives in the parent, not here. InputBar owns the
  highlight index because it owns the arrow-key handling, and passes it
  down as `HighlightIndex`; this component is pure presentation and emits
  nothing. Both sides guard against an empty list - the box unmounts via
  `Visible` when nothing matches, so the parent's index is only ever read
  while at least one row exists.
-->
<script setup lang="ts">
import { UseChatStore } from '@/Stores/Chat';
import { computed } from 'vue';

defineProps<{
  HighlightIndex: number;
}>();

const Chat = UseChatStore();
/**
 * Unmount the box entirely when nothing matches - which is also what
 * keeps the parent's highlight index safe to read, since it is only
 * dereferenced while at least one row exists.
 */
const Visible = computed<boolean>(() => Chat.Suggestions.length > 0);
</script>

<template>
  <div v-if="Visible" class="Chat-Suggestions">
    <div
      v-for="(Hint, Index) in Chat.Suggestions"
      :key="Hint.Name"
      class="Chat-Suggestion"
      :class="{ Active: Index === HighlightIndex }"
    >
      <span class="Chat-Suggestion-Name">/{{ Hint.Name }}</span>
      <span v-if="Hint.Params.length > 0" class="Chat-Suggestion-Params"
      >&nbsp;{{ Hint.Params }}</span
      >
      <span v-if="Hint.Description.length > 0" class="Chat-Suggestion-Desc">
        — {{ Hint.Description }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.Chat-Suggestions {
  background: rgba(0, 0, 0, 0.75);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding: 0.25rem 0;
  max-height: 12rem;
  overflow-y: auto;
  font-size: 0.9rem;
}

.Chat-Suggestion {
  padding: 0.15rem 0.6rem;
  color: rgba(255, 255, 255, 0.85);
}
.Chat-Suggestion.Active {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.Chat-Suggestion-Name {
  /* Emerald to match the chat brand (.mp accent, block frames) rather
     than the formatter's CMD red - the dropdown reads as "Legacy
     command surface" instead of "danger". */
  color: #10b981;
  font-weight: 600;
}

.Chat-Suggestion-Params {
  color: #ffe066;
}

.Chat-Suggestion-Desc {
  color: rgba(255, 255, 255, 0.6);
}
</style>
