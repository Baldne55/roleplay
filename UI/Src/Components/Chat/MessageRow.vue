<script setup lang="ts">
import { computed } from 'vue';
import type { ChatSegment } from '@Shared/Chat/Index';
import { useChatStore } from '@/Stores/Chat';

const Props = defineProps<{ Segments: ChatSegment[]; ReceivedAt: number }>();

const Chat = useChatStore();

/** `[HH:MM:SS]` derived from ReceivedAt; only rendered when /toggle
 * timestamp is on. Local wall-clock; no timezone math. */
const TimestampLabel = computed<string>(() => {
  const D = new Date(Props.ReceivedAt);
  const Pad = (N: number): string => N.toString().padStart(2, '0');
  return `[${Pad(D.getHours())}:${Pad(D.getMinutes())}:${Pad(D.getSeconds())}]`;
});
</script>

<template>
  <div class="Chat-Row">
    <span v-if="Chat.TimestampVisible" class="Chat-Row-Timestamp"
      >{{ TimestampLabel }} </span
    >
    <span
      v-for="(Segment, Index) in Segments"
      :key="Index"
      :style="{ color: Segment.Color }"
      >{{ Segment.Text }}</span
    >
  </div>
</template>

<style scoped>
.Chat-Row {
  /* Pre-wrap so server-emitted newlines render as line breaks. */
  white-space: pre-wrap;
  /* Drop shadow for legibility against arbitrary game backdrops, matching
     HUD overlay convention (see feedback_hud_overlay_style memory). */
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
  line-height: 1.35;
  /* /fontsize scales the row via the root's --chat-font-scale variable. */
  font-size: calc(0.95rem * var(--chat-font-scale, 1));
  font-weight: 500;
}

.Chat-Row-Timestamp {
  color: rgba(255, 255, 255, 0.55);
}
</style>
