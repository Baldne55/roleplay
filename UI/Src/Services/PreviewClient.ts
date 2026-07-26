import type {
  AppearanceData,
  Gender,
  PreviewCamera,
} from '@Shared/Constants/Character';
import type { OutfitData } from '@Shared/Constants/Outfit';

/**
 * Thin POST wrapper for the Frontend's character-preview NUI callbacks.
 *
 *   StartPreview(Gender)         -> Frontend reveals ped + frames camera
 *   ApplyAppearance(Data)        -> Frontend re-applies full appearance
 *   ApplyCamera(Spec)            -> Frontend re-positions scripted camera
 *   StopPreview()                -> Frontend hides ped + tears down camera
 *
 * Callers are responsible for throttling - the appearance / camera endpoints
 * fire on every slider drag in the UI; we send each through but the
 * Frontend can handle the cadence (native calls are cheap, local-only).
 */
class PreviewClient {
  /**
   * POST to a NUI callback, swallowing transport failures.
   *
   * Preview calls fire on every slider drag, so a dropped one is not
   * worth surfacing - the next edit supersedes it. Rejecting here would
   * turn a cosmetic hiccup into an unhandled rejection mid-drag.
   */
  private async Post(Endpoint: string, Body: unknown): Promise<void> {
    try {
      await fetch(`https://roleplay/${Endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Body),
      });
    } catch {
      // Not in CEF (dev preview); ignore - the SPA can still render.
    }
  }

  /** Spawn the creator's preview ped. Must precede any Apply* call. */
  StartPreview(Gender: Gender): Promise<void> {
    return this.Post('CharacterPreviewStart', { Gender });
  }

  /**
   * Restyle the preview ped's face, hair and overlays. Kept separate from
   * ApplyOutfit and ApplyCamera because each hits different natives at
   * different cost - a slider drag applies only the axis it changed.
   */
  ApplyAppearance(Appearance: AppearanceData): Promise<void> {
    return this.Post('CharacterPreviewApply', { Appearance });
  }

  /** Re-dress the preview ped's clothing components. */
  ApplyOutfit(Outfit: OutfitData): Promise<void> {
    return this.Post('CharacterPreviewOutfit', { Outfit });
  }

  /** Reframe the preview camera. Does not touch the ped, so it stays cheap. */
  ApplyCamera(Camera: PreviewCamera): Promise<void> {
    return this.Post('CharacterPreviewCamera', { Camera });
  }

  /**
   * Tear down the preview and return the ped to the auth skybox.
   *
   * Only for abandoning the wizard. Once a submit is in flight the spawn
   * pipeline owns the ped, and calling this would fight it - see
   * CreatorView's unmount guard.
   */
  StopPreview(): Promise<void> {
    return this.Post('CharacterPreviewStop', {});
  }
}

/**
 * Process-wide singleton. There is exactly one ped being previewed at a
 * time, so per-component instances would only create opportunities for
 * two of them to issue conflicting start/stop calls against it.
 */
export const Preview = new PreviewClient();
