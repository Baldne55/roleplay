<!--
  Sign-in card - the first surface a connecting player sees, painted over
  the auth skybox while the deferral queue holds their connection.

  There are no credentials to collect. Identity comes from the FiveM
  Discord identifier the server already resolved during deferrals, so
  this view's whole job is to show the player who the server thinks they
  are and take one confirming click.

  Every computed here is a projection of `Auth.Phase` (see Stores/Auth for
  the full machine). The four this view renders:

    Idle        identity not resolved yet - avatar hidden, button inert
    Prepared    Discord name/avatar in hand, ready to submit
    Submitting  AuthFinalize is in flight, button spinner, input locked
    Failed      server declined or the callback threw; submit re-enabled

  The fifth, `Authenticated`, is never rendered here - it is the router's
  cue to leave for the selector or the creation wizard, so this view
  unmounts on the transition into it.

  `Failed` is deliberately re-submittable rather than terminal: the usual
  causes (a transient DB hiccup, a webhook timeout) resolve on a retry,
  and the alternative is telling the player to reconnect and re-queue.
  /logout comes back through `ResetForReturn`, which rewinds to `Prepared`
  rather than `Idle` because the server has not re-run the identity gate.

  The theme picker sits here rather than in a settings screen because
  this is the only surface guaranteed to be visible before a character
  exists - the choice has to be made before there is an account settings
  row to persist it against.
-->
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
import { ThemeModes, type ThemeMode } from '@Shared/Constants/AccountSettings';
import { UseAuthStore } from '@/Stores/Auth';
import { UseSettingsStore } from '@/Stores/Settings';
import LogoUrl from '@/Assets/Auth/Logo.png';

const Auth = UseAuthStore();
const Settings = UseSettingsStore();

/** Show the Discord avatar only once identity has resolved; else the logo. */
const ShowAvatar = computed(
  () => Auth.DiscordAvatarURL !== null && Auth.Phase !== 'Idle',
);

/** Drives the button's loading spinner while AuthFinalize is in flight. */
const IsSubmitting = computed(() => Auth.Phase === 'Submitting');
/** Failed is submittable as well as Prepared - the usual causes are transient. */
const CanSubmit = computed(() => Auth.Phase === 'Prepared' || Auth.Phase === 'Failed');

/** Greeting, personalised once the Discord name is known. */
const Headline = computed(() => {
  if (Auth.Phase === 'Idle') return 'Welcome';
  return `Welcome, ${Auth.DiscordDisplayName ?? 'friend'}.`;
});

/** One line of status per phase, so the card always says what it is doing. */
const Subhead = computed(() => {
  if (Auth.Phase === 'Idle') return 'Resolving your Discord identity...';
  if (Auth.Phase === 'Submitting') return 'Securing your session...';
  if (Auth.Phase === 'Failed') return 'Sign-in was not completed. You can try again.';
  return 'Ready to enter the server.';
});

/** Button text per phase - "Try again" on Failed, since it is retryable. */
const ButtonLabel = computed(() => {
  if (Auth.Phase === 'Submitting') return 'Entering...';
  if (Auth.Phase === 'Failed') return 'Try again';
  if (Auth.Phase === 'Idle') return 'Please wait';
  return 'Enter Server';
});

/**
 * Icon shown on the theme cycle button per mode. A full Record over
 * ThemeMode, so adding a mode is a compile error here until it is given
 * an icon rather than silently rendering nothing.
 */
const ThemeIcons: Record<ThemeMode, typeof IconSun> = {
  Light: IconSun,
  Dark: IconMoon,
  System: IconDeviceLaptop,
};

/**
 * Confirm sign-in. Flips the store to `Submitting` first so the button
 * disables on the same tick as the request leaving - without that, a
 * double-click sends two AuthFinalize callbacks and the server spawns
 * the session twice.
 *
 * Only the transport failure is handled here. A server-side rejection
 * arrives asynchronously as its own NUI message and is routed to
 * `Auth.HandleFailure` by NuiInbox, not through this promise.
 */
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
          >
          <img
            v-else
            :src="LogoUrl"
            alt="Roleplay"
            class="AuthLogo"
          >
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
                :severity="Settings.ThemeMode === Choice ? 'primary' : 'secondary'"
                :outlined="Settings.ThemeMode !== Choice"
                :label="Choice"
                :aria-checked="Settings.ThemeMode === Choice"
                @click="Settings.SetThemeMode(Choice)"
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
