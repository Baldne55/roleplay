import type {
  CommandBeforeRun,
  CommandBeforeRunOutcome,
} from '@/Services/CommandTypes.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';

/**
 * Shared BeforeRun gate for IC-channel commands. Refuses to dispatch
 * while the runtime carries a non-Healthy InjuryStatus. Speech, action,
 * directed speech, vehicle chat, and nametag-action commands all wear
 * this so an unconscious / wounded / dead character can not speak
 * in-character regardless of the registration call site. OOC (/b /ooc),
 * PMs, /id, /acceptdeath, and admin commands deliberately skip it.
 *
 * Returns Ok=true when the runtime is missing (the dispatcher's
 * RequireCharacter gate will already have refused if a character is
 * actually required) so a freshly-connected auth-shell player does not
 * trip an injury error before the normal RequiresCharacter outcome.
 *
 * The strict-formal wording matches the rest of the chat cluster -
 * single sentence, no contractions, fits the
 * [feedback_prose_voice_formal] register.
 */
export function AssertHealthy(
  Runtimes: CharacterRuntimeService,
): CommandBeforeRun {
  return (Ctx) => {
    const Runtime = Runtimes.Get(Ctx.Source);
    if (Runtime === null) return { Ok: true };
    if (Runtime.InjuryStatus !== 'Healthy') {
      return {
        Ok: false,
        Reason: 'You cannot speak. You are incapacitated.',
      };
    }
    return { Ok: true };
  };
}

/**
 * Compose multiple BeforeRun guards into one. Runs them in order; the
 * first non-Ok short-circuits with that outcome. Use to layer
 * AssertHealthy on top of an existing command-specific guard
 * (AssertNonEmptyBody, range gate, etc.) without rewriting every
 * call site.
 */
export function ChainBeforeRun(
  ...Guards: readonly CommandBeforeRun[]
): CommandBeforeRun {
  return async (Ctx): Promise<CommandBeforeRunOutcome> => {
    for (const Guard of Guards) {
      const Outcome = await Guard(Ctx);
      if (!Outcome.Ok) return Outcome;
    }
    return { Ok: true };
  };
}
