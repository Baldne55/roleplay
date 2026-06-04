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

/**
 * PageUp / PageDown in the input bar bumps `ScrollCounter` on the store.
 * Each tick we scroll the list by `±PageSize` rows. Row height is
 * derived from the live layout (mean rendered height) so the step
 * tracks /fontsize changes without recomputation - if the list is
 * empty, fall back to a sane 20 px estimate.
 */
watch(
  () => Chat.ScrollCounter,
  () => {
    const El = ListEl.value;
    if (El === null) return;
    const RowCount = El.children.length;
    const PerRow = RowCount > 0 ? El.scrollHeight / RowCount : 20;
    El.scrollTop += Chat.ScrollDirection * Chat.PageSize * PerRow;
  },
);
</script>

<template>
  <div ref="ListEl" class="Chat-List">
    <MessageRow
      v-for="Message in Chat.Messages"
      :key="Message.ID"
      :Segments="Message.Segments"
      :ReceivedAt="Message.ReceivedAt"
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
  /* /pagesize sets the visible row count; /fontsize scales the per-row
     height so the visible window stays at N rows regardless of font.
     One row is roughly font-size * line-height = 0.95rem * 1.35 ≈ 1.3rem
     at scale=1, plus the 0.15rem gap between rows. */
  max-height: calc(
    var(--chat-page-size, 20) *
      (1.3rem * var(--chat-font-scale, 1) + 0.15rem) +
      0.8rem
  );
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
