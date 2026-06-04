<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from '@/Stores/Chat';
import MessageList from '@/Components/Chat/MessageList.vue';
import InputBar from '@/Components/Chat/InputBar.vue';

const Chat = useChatStore();

// Render the shell as long as there's anything to show or the input is
// open. A freshly spawned player with zero messages sees nothing until
// the first push lands (or they hit T).
//
// `Chat.ChatVisible` is the /toggle chat user-controlled gate: when off,
// the overlay disappears entirely (the player chose to hide it). New
// pushes still accumulate in the store so they reappear on /toggle chat
// back on.
const Visible = computed<boolean>(
  () => Chat.ChatVisible && (Chat.Messages.length > 0 || Chat.InputActive),
);

// FontSize controls the chat overlay's relative font scaling. The store
// holds it as a multiplier (default 0.65 keeps rough parity with the
// legacy size); we feed it to CSS as a custom property so every nested
// rule that uses `em` re-scales together.
//
// PageSize is the visible row count in the message list. The list's
// max-height multiplies it by the scaled row height so /pagesize +
// /fontsize compose correctly.
const RootStyle = computed(() => ({
  '--chat-font-scale': String(Chat.FontSize / 0.65),
  '--chat-page-size': String(Chat.PageSize),
}));
</script>

<template>
  <section
    v-if="Visible"
    class="Chat-Root"
    :class="{ 'Chat-Root--Blindfold': Chat.BlindfoldOn }"
    :style="RootStyle"
  >
    <MessageList />
    <InputBar v-if="Chat.InputActive" />
  </section>
</template>

<style scoped>
.Chat-Root {
  position: fixed;
  left: 1.2vw;
  top: 3vh;
  width: 38vw;
  /* Safety ceiling so an extreme /pagesize + /fontsize combo cannot
     overflow the viewport. The list's own max-height drives the
     normal sizing. */
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: transparent;
  /* Inter is already bundled via @fontsource (see Main.ts) and matches
     the look both lc-rp (Open Sans / Myriad Pro) and roleplay_ragemp
     (Arial / Open Sans / Inter from a 21-font catalogue) lean on -
     proportional, slightly humanist. Block borders use `====` runs
     (not `|---|`) which read fine at proportional widths. */
  font-family: 'Inter', 'Open Sans', system-ui, sans-serif;
  pointer-events: auto;
  /* Sit above any PrimeVue overlay (Dialog default is 1100; Tooltip 1200).
     9999 keeps the chat surface above anything the SPA might float
     during in-world UX. */
  z-index: 9999;
  /* /fontsize multiplier - 1 = default. CSS rules in this tree scale via
     `calc(<base> * var(--chat-font-scale))`. */
  --chat-font-scale: 1;
}

/* /toggle blindfold paints a solid black backdrop so chat is legible
   against any in-world background (used for screenshots). */
.Chat-Root--Blindfold {
  background: #000000;
}
</style>
