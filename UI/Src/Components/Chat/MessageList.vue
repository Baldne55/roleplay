<!--
  The scrollback: renders `Chat.Messages` as MessageRows and owns the
  scroll position.

  Scrolling is driven by two watchers rather than by template state,
  because both effects need the DOM to have already been updated. The
  first pins the view to the bottom whenever a message arrives; the second
  responds to PageUp/PageDown, which InputBar signals by bumping a counter
  on the store rather than calling in directly (the two components never
  reference each other).

  Deliberately not virtualised - the store caps the buffer at 100 rows
  (MessageCap), which plain `v-for` handles at frame rate. Row heights are
  also wildly unequal here, since a single message can be a whole framed
  block (/help, /admins), which is what makes the windowing arithmetic in
  the scroll watcher subtler than it looks.
-->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { UseChatStore } from '@/Stores/Chat';
import MessageRow from '@/Components/Chat/MessageRow.vue';

const Chat = UseChatStore();
/** The scroll container. Both watchers below drive `scrollTop` through it. */
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
 * Each tick we scroll by exactly one visible window.
 *
 * `clientHeight` IS the page: the list's max-height is already derived
 * from /pagesize and /fontsize in CSS below, so reading it back tracks
 * both without recomputing either. It also stays correct for rows of
 * unequal height - one ChatMessage can be a whole framed block (/help,
 * /admins, the Welcome Back card) rendered as a single pre-wrap child
 * spanning twenty-odd visual lines. The previous step, `PageSize x mean
 * row height`, treated those as if every row were that tall and jumped
 * several screens per keypress, skipping the content in between.
 */
watch(
  () => Chat.ScrollCounter,
  () => {
    const El = ListEl.value;
    if (El === null) return;
    El.scrollTop += Chat.ScrollDirection * El.clientHeight;
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
