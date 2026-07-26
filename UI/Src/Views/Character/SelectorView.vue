<!--
  Character roster - the surface between signing in and entering the
  world. Lists the account's Active characters and takes the one click
  that spawns the chosen one.

  The list is fetched rather than passed in, because this view is
  reachable twice in a session: once after auth, and again after a
  /logout returns the player here with a roster that may have changed.
  `onMounted` refetches on `Idle` or `Failed` but not on `Loaded`, so the
  common return trip reuses the cached roster while a previously failed
  load gets a fresh attempt.

  Spawning is single-flight. `List.SelectingID` holds the character being
  spawned and disables every Play button on the page, not just the one
  clicked - two spawn requests in flight would have the server attach two
  runtimes to one session. The store clears it on failure so the roster
  becomes interactive again.

  Deleted characters never appear: the server sends only Active rows, so
  there is no soft-delete filtering to do on this side.
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import { IconPlus, IconPlayerPlay, IconUserCircle } from '@tabler/icons-vue';
import type { CharacterSummary } from '@Shared/Constants/Character';
import { UseCharacterListStore } from '@/Stores/CharacterList';

const List = UseCharacterListStore();
const Router = useRouter();

/** Roster fetch in flight. */
const IsLoading = computed<boolean>(() => List.Status === 'Loading');
/** Loaded but empty - distinct from still-loading, which shows a spinner instead. */
const IsEmpty = computed<boolean>(
  () => List.Status === 'Loaded' && List.Characters.length === 0,
);

/**
 * Enter the world as `ID`. The guard is a second line of defence behind
 * the buttons' `:disabled` binding - a keyboard-driven double activation
 * can fire twice before Vue flushes the disabled attribute.
 */
function PlayCharacter(ID: string): void {
  if (List.SelectingID !== null) return;
  void List.Select(ID);
}

/**
 * Leave for step 1 of the creation wizard. The rejection is swallowed
 * because vue-router rejects the promise on a cancelled navigation, which
 * here just means the player clicked twice - not an error worth surfacing.
 */
function CreateNewCharacter(): void {
  Router.push('/Character/Details').catch(() => {
    /* navigation guard cancels are silent */
  });
}

/**
 * Render a last-login stamp as a short local date.
 *
 * Handles both "never played" (null) and an unparseable stamp, so a bad
 * value from the server degrades to "Unknown" rather than printing
 * "Invalid Date" on the roster.
 */
function FormatLastLogin(Iso: string | null): string {
  if (Iso === null) return 'Never played';
  const When = new Date(Iso);
  if (Number.isNaN(When.getTime())) return 'Unknown';
  // Locale-default short date; suppresses time-of-day for compactness.
  return When.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Slot label for the roster row. Slots are 1-based and account-scoped. */
function SlotLabel(Char: CharacterSummary): string {
  return `Slot ${Char.SlotID}`;
}

onMounted(() => {
  if (List.Status === 'Idle' || List.Status === 'Failed') {
    void List.LoadList();
  }
});
</script>

<template>
  <main class="SelectorRoot">
    <Card class="SelectorCard" role="dialog" aria-labelledby="SelectorHeadline">
      <template #header>
        <div class="SelectorHeader">
          <div class="SelectorHeaderIcon">
            <IconUserCircle :size="22" />
          </div>
          <div>
            <h1 id="SelectorHeadline" class="SelectorHeadline">Select a Character</h1>
            <p class="SelectorSubhead">
              Pick a character to enter the world, or create a new one.
            </p>
          </div>
        </div>
      </template>

      <template #content>
        <div v-if="IsLoading" class="EmptyHint">Loading characters...</div>

        <div v-else-if="IsEmpty" class="EmptyHint">
          You haven't created any characters yet.
        </div>

        <ul v-else class="CharacterList" role="list">
          <li
            v-for="Char in List.Characters"
            :key="Char.ID"
            class="CharacterRow"
          >
            <div class="CharacterInfo">
              <p class="CharacterName">{{ Char.FirstName }} {{ Char.LastName }}</p>
              <p class="CharacterMeta">
                {{ SlotLabel(Char) }}
                <span class="MetaSep">&middot;</span>
                {{ Char.Gender }}
                <span class="MetaSep">&middot;</span>
                {{ FormatLastLogin(Char.LastLoginAt) }}
              </p>
            </div>
            <Button
              severity="primary"
              size="small"
              :label="List.SelectingID === Char.ID ? 'Spawning...' : 'Play'"
              :loading="List.SelectingID === Char.ID"
              :disabled="List.SelectingID !== null"
              @click="PlayCharacter(Char.ID)"
            >
              <template #icon><IconPlayerPlay :size="14" /></template>
            </Button>
          </li>
        </ul>

        <Message
          v-if="List.Reason"
          severity="error"
          :closable="false"
          class="ErrorMessage"
        >
          {{ List.Reason }}
        </Message>
      </template>

      <template #footer>
        <Button
          severity="secondary"
          label="Create New Character"
          fluid
          :disabled="List.SelectingID !== null"
          @click="CreateNewCharacter"
        >
          <template #icon><IconPlus :size="16" /></template>
        </Button>
      </template>
    </Card>
  </main>
</template>

<style scoped>
.SelectorRoot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1.5rem;
  background: rgba(0, 0, 0, 0.4);
}

.SelectorCard {
  width: 26rem;
  max-width: calc(100vw - 3rem);
}

.SelectorHeader {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem 0;
}

.SelectorHeaderIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
  border-radius: 9999px;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

.SelectorHeadline {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
}

.SelectorSubhead {
  margin: 0.125rem 0 0 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.CharacterList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.CharacterRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: var(--p-content-border-radius);
  background: color-mix(in srgb, var(--p-content-background) 60%, transparent);
  border: 1px solid var(--p-content-border-color);
}

.CharacterInfo {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.CharacterName {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--p-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.CharacterMeta {
  margin: 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.MetaSep {
  margin: 0 0.25rem;
}

.EmptyHint {
  text-align: center;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  padding: 1.5rem 0;
}

.ErrorMessage {
  margin-top: 1rem;
}
</style>
