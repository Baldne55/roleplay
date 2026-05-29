<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from '@/Stores/Chat';
import MessageList from '@/Components/Chat/MessageList.vue';
import InputBar from '@/Components/Chat/InputBar.vue';

const Chat = useChatStore();

// Render the shell as long as there's anything to show or the input is
// open. A freshly spawned player with zero messages sees nothing until
// the first push lands (or they hit T).
const Visible = computed<boolean>(
  () => Chat.Messages.length > 0 || Chat.InputActive,
);
</script>

<template>
  <section v-if="Visible" class="Chat-Root">
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
  max-height: 40vh;
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
}
</style>
