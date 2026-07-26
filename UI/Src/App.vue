<template>
  <RouterView />
  <ChatRoot v-if="ChatVisible" />
</template>

<script setup lang="ts">
/**
 * SPA root. Two children, deliberately siblings rather than nested: the
 * routed surface (auth, selector, creation wizard) and the chat overlay.
 *
 * Chat sits outside the RouterView so that scrollback survives navigation
 * - a player who reads a welcome notice on /Auth still has it when they
 * reach the selector. Keeping it here rather than inside each view is
 * also what lets a single route-name check suppress it wholesale on the
 * surfaces that must paint clean.
 *
 * There is no layout, header or chrome at this level: every view paints
 * its own full-screen card over a transparent body so the game shows
 * through.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ChatRoot from '@/Components/Chat/ChatRoot.vue';

// Chat overlay is mounted from /Auth onward so the welcome line lands
// while the player is still in the skybox shell. The InputBar (T key /
// send) is gated separately on CharacterSpawned in the Frontend - chat
// is read-only before the player picks a character.
//
// Routes that suppress it:
//   /Hidden            - pre-AuthShow, nothing should paint.
//   /Character/Details - creation wizard step 1 (background form).
//   /Character/Creator - creation wizard step 2 (live ped preview).
//
// Chat stays mounted on /Auth and /Character/Select so the welcome /
// notice scrollback remains visible up to the point of entering the
// creator.
const ChatHiddenRoutes = new Set<string>([
  'Hidden',
  'CharacterDetails',
  'CharacterCreator',
]);
const Route = useRoute();
/** Route-level chat suppression; the player's own /toggle lives in ChatRoot. */
const ChatVisible = computed<boolean>(
  () => typeof Route.name === 'string' && !ChatHiddenRoutes.has(Route.name),
);
</script>
