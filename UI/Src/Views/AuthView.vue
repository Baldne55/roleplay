<script setup lang="ts">
import { computed } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Message from 'primevue/message';
import {
  IconArrowRight,
  IconDeviceLaptop,
  IconLogin2,
  IconMoon,
  IconSun,
} from '@tabler/icons-vue';
import { useAuthStore } from '@/Stores/Auth';
import { useThemeStore } from '@/Stores/Theme';
import { ThemeModes, type ThemeMode } from '@/Services/Theme';
import LogoUrl from '@/Assets/Auth/Logo.png';

const Auth = useAuthStore();
const Theme = useThemeStore();

const ShowAvatar = computed(
  () => Auth.DiscordAvatarURL !== null && Auth.Phase !== 'Idle',
);

const IsSubmitting = computed(() => Auth.Phase === 'Submitting');
const CanSubmit = computed(() => Auth.Phase === 'Prepared' || Auth.Phase === 'Failed');

const Headline = computed(() => {
  if (Auth.Phase === 'Idle') return 'Welcome';
  return `Welcome, ${Auth.DiscordDisplayName ?? 'friend'}.`;
});

const Subhead = computed(() => {
  if (Auth.Phase === 'Idle') return 'Resolving your Discord identity...';
  if (Auth.Phase === 'Submitting') return 'Securing your session...';
  if (Auth.Phase === 'Failed') return 'Sign-in was not completed. You can try again.';
  return 'Ready to enter the server.';
});

const ButtonLabel = computed(() => {
  if (Auth.Phase === 'Submitting') return 'Entering...';
  if (Auth.Phase === 'Failed') return 'Try again';
  if (Auth.Phase === 'Idle') return 'Please wait';
  return 'Enter Server';
});

const ThemeIcons: Record<ThemeMode, typeof IconSun> = {
  Light: IconSun,
  Dark: IconMoon,
  System: IconDeviceLaptop,
};

function HandleEnter(): void {
  if (!CanSubmit.value) return;
  Auth.BeginSubmitting();
  void fetch('https://roleplay/AuthFinalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch((Err: unknown) => {
    Auth.HandleFailure(`Could not contact the server: ${String(Err)}`);
  });
}
</script>

<template>
  <main class="AuthRoot">
    <Card class="AuthCard" role="dialog" aria-labelledby="AuthHeadline">
      <template #header>
        <div class="AuthCardHeader">
          <img
            v-if="ShowAvatar"
            :src="Auth.DiscordAvatarURL ?? ''"
            alt=""
            class="AuthAvatar"
          />
          <img
            v-else
            :src="LogoUrl"
            alt="Roleplay"
            class="AuthLogo"
          />
        </div>
      </template>
      <template #title>
        <h1 id="AuthHeadline" class="AuthHeadline">{{ Headline }}</h1>
      </template>
      <template #subtitle>
        <p class="AuthSubhead">{{ Subhead }}</p>
      </template>
      <template #content>
        <div class="AuthBody">
          <Button
            type="button"
            :label="ButtonLabel"
            size="small"
            icon-pos="right"
            fluid
            :loading="IsSubmitting"
            :disabled="!CanSubmit"
            @click="HandleEnter"
          >
            <template #icon>
              <IconLogin2 v-if="Auth.Phase === 'Idle' || IsSubmitting" :size="16" />
              <IconArrowRight v-else :size="16" />
            </template>
          </Button>

          <Message
            v-if="Auth.Reason"
            severity="error"
            :closable="false"
          >
            {{ Auth.Reason }}
          </Message>

          <fieldset class="ThemePicker">
            <legend class="ThemePickerLegend">Theme</legend>
            <div role="radiogroup" aria-label="Theme" class="ThemeButtons">
              <Button
                v-for="Choice in ThemeModes"
                :key="Choice"
                type="button"
                role="radio"
                size="small"
                :severity="Theme.Mode === Choice ? 'primary' : 'secondary'"
                :outlined="Theme.Mode !== Choice"
                :label="Choice"
                :aria-checked="Theme.Mode === Choice"
                @click="Theme.Set(Choice)"
              >
                <template #icon>
                  <component :is="ThemeIcons[Choice]" :size="14" />
                </template>
              </Button>
            </div>
          </fieldset>
        </div>
      </template>
      <template #footer>
        <p class="AuthFooterNote">
          Connections are bound to your Discord identity. No password to remember.
        </p>
      </template>
    </Card>
  </main>
</template>

<style scoped>
.AuthRoot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1.5rem;
  background: rgba(0, 0, 0, 0.4);
}

.AuthCard {
  width: 20rem;
}

.AuthCardHeader {
  display: flex;
  justify-content: center;
  padding-top: 1.25rem;
}

.AuthAvatar {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 9999px;
  object-fit: cover;
  user-select: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--p-primary-color) 40%, transparent);
}

.AuthLogo {
  height: 4rem;
  width: auto;
  max-width: 14rem;
  object-fit: contain;
  user-select: none;
}

.AuthHeadline {
  margin: 0;
  text-align: center;
  font-size: 1.125rem;
  font-weight: 600;
}

.AuthSubhead {
  margin: 0;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.AuthBody {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.ThemePicker {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border: 0;
  padding: 0;
  margin: 0;
}

.ThemePickerLegend {
  margin: 0;
  padding: 0;
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.ThemeButtons {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.375rem;
}

.AuthFooterNote {
  margin: 0;
  text-align: center;
  font-size: 0.65rem;
  line-height: 1.5;
  color: var(--p-text-muted-color);
}
</style>
