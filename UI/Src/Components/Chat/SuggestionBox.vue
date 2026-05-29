<script setup lang="ts">
import { useChatStore } from '@/Stores/Chat';
import { computed } from 'vue';

defineProps<{
  HighlightIndex: number;
}>();

const Chat = useChatStore();
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
