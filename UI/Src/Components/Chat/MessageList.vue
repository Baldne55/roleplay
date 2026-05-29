<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useChatStore } from '@/Stores/Chat';
import MessageRow from '@/Components/Chat/MessageRow.vue';

const Chat = useChatStore();
const ListEl = ref<HTMLElement | null>(null);

/**
 * On every push, scroll the list to the bottom. We re-run on the array
 * length, not the array reference, so identity-stable mutations from
 * Pinia trigger correctly.
 */
watch(
  () => Chat.Messages.length,
  () => {
    void nextTick(() => {
      const El = ListEl.value;
      if (El !== null) El.scrollTop = El.scrollHeight;
    });
  },
);

</script>

<template>
  <div ref="ListEl" class="Chat-List">
    <MessageRow
      v-for="Message in Chat.Messages"
      :key="Message.ID"
      :Segments="Message.Segments"
    />
  </div>
</template>

<style scoped>
.Chat-List {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.4rem 0.6rem;
  /* Plain v-for, no virtualisation - 100 rows at 60fps is fine. */
}

.Chat-List::-webkit-scrollbar {
  width: 4px;
}
.Chat-List::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}
.Chat-List::-webkit-scrollbar-track {
  background: transparent;
}
</style>
