import { defineStore } from 'pinia';
import { ref } from 'vue';

export type AuthPhase = 'Idle' | 'Prepared' | 'Submitting' | 'Authenticated' | 'Failed';

/**
 * SPA-side auth state.
 *
 *   Idle           - card shown, waiting for the server to resolve Discord
 *                    identity. Briefly the case on first render.
 *   Prepared       - server fired AuthPrepared with the profile preview.
 *                    Card shows "Welcome, {DisplayName}" + avatar; button
 *                    enabled.
 *   Submitting     - user clicked Enter; we've POSTed AuthFinalize; waiting
 *                    for AuthSuccess/AuthFailure.
 *   Authenticated  - server fired AuthSuccess; router will switch to
 *                    /Character/Select (has characters) or /Character/Details (zero).
 *   Failed         - finalize rejected; Reason populated. User can retry.
 */
export const useAuthStore = defineStore('Auth', () => {
  const Phase = ref<AuthPhase>('Idle');
  const Reason = ref<string | null>(null);
  const DiscordDisplayName = ref<string | null>(null);
  const DiscordAvatarURL = ref<string | null>(null);
  /** True iff the resolved account owns at least one Active character. */
  const HasCharacters = ref<boolean>(false);

  function HandlePrepared(Name: string, AvatarURL: string | null): void {
    DiscordDisplayName.value = Name;
    DiscordAvatarURL.value = AvatarURL;
    Reason.value = null;
    Phase.value = 'Prepared';
  }

  function BeginSubmitting(): void {
    Reason.value = null;
    Phase.value = 'Submitting';
  }

  function HandleSuccess(
    Name: string,
    AvatarURL: string | null,
    OwnsCharacters: boolean,
  ): void {
    DiscordDisplayName.value = Name;
    DiscordAvatarURL.value = AvatarURL;
    HasCharacters.value = OwnsCharacters;
    Reason.value = null;
    Phase.value = 'Authenticated';
  }

  function HandleFailure(Why: string): void {
    Reason.value = Why;
    Phase.value = 'Failed';
  }

  /**
   * Rewind to the post-Prepared, pre-Submit state after a /logout. The
   * Discord identity is still resolved (server hasn't re-run the gate),
   * so we keep the cached display name + avatar and just re-enable the
   * Enter Server button.
   */
  function ResetForReturn(): void {
    Reason.value = null;
    HasCharacters.value = false;
    Phase.value = DiscordDisplayName.value !== null ? 'Prepared' : 'Idle';
  }

  return {
    Phase,
    Reason,
    DiscordDisplayName,
    DiscordAvatarURL,
    HasCharacters,
    HandlePrepared,
    BeginSubmitting,
    HandleSuccess,
    HandleFailure,
    ResetForReturn,
  };
});
