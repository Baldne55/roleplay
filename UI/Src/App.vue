<template>
  <RouterView />
  <ChatRoot v-if="ChatVisible" />
</template>

<script setup lang="ts">
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
const ChatVisible = computed<boolean>(
  () => typeof Route.name === 'string' && !ChatHiddenRoutes.has(Route.name),
);
</script>
