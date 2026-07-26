<!--
  Shell for the in-world chat overlay: owns visibility, the two player
  display preferences that have to cascade, and the composition of
  MessageList over InputBar.

  Mounted from App.vue as a sibling of the RouterView, not inside it, so
  the overlay survives navigation between the auth, selector and in-world
  surfaces instead of remounting per route. App.vue suppresses it on the
  three routes that must paint clean (/Hidden and the two character-creation
  steps); this component's own `Visible` gate is the player-facing one.
  Fixed-position with `pointer-events: auto`, so it floats above the SPA
  rather than participating in its layout.

  Two things belong at this level rather than lower down:

    - Visibility. Both the /toggle chat gate and the "nothing to show
      yet" case collapse the whole subtree. Messages keep accumulating in
      the store while hidden, so toggling back on restores history rather
      than starting blank.
    - The /fontsize and /pagesize scalars, published as CSS custom
      properties. Descendant rules size themselves off `--chat-font-scale`
      via calc(), which is what lets the two settings compose - the list's
      max-height is page-size * scaled-row-height, so raising the font
      grows the box instead of clipping rows.

  InputBar is mounted conditionally and MessageList unconditionally: the
  draft line's mount/unmount drives NUI focus acquisition, so it must not
  exist while the player is not typing.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { UseChatStore } from '@/Stores/Chat';
import MessageList from '@/Components/Chat/MessageList.vue';
import InputBar from '@/Components/Chat/InputBar.vue';

const Chat = UseChatStore();

// Render the shell as long as there's anything to show or the input is
// open. A freshly spawned player with zero messages sees nothing until
// the first push lands (or they hit T).
//
// `Chat.ChatVisible` is the /toggle chat user-controlled gate: when off,
// the overlay disappears entirely (the player chose to hide it). New
// pushes still accumulate in the store so they reappear on /toggle chat
// back on.
/**
 * Two gates in one: the player's /toggle preference, and "is there
 * anything to show". Messages keep accumulating while hidden, so toggling
 * back on restores scrollback rather than starting blank.
 */
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
/**
 * Publish /fontsize and /pagesize as CSS custom properties, so descendant
 * rules can size themselves off them via calc() - that is what makes the
 * two settings compose instead of clipping each other.
 */
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
