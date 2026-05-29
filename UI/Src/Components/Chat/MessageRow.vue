<script setup lang="ts">
import type { ChatSegment } from '@Shared/Chat/Index';

defineProps<{ Segments: ChatSegment[] }>();
</script>

<template>
  <div class="Chat-Row">
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
  font-size: 0.95rem;
  font-weight: 500;
}
</style>
