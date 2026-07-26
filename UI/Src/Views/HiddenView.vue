<!--
  The default route: deliberately paints nothing.

  The SPA is always mounted and listening for NUI messages, but must be
  invisible until a controller routes somewhere. A blank route is how that
  is expressed - the alternative, unmounting the app between surfaces,
  would tear down the message inbox with it and lose anything sent while
  it was gone.

  The element exists rather than rendering nothing at all so the router
  always has a component to mount; Style.css keeps it invisible.
-->
<template>
  <div class="Hidden-Root" />
</template>

<script setup lang="ts">
// No logic - see the block comment above.
</script>
