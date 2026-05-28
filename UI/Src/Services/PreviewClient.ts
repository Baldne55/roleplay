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

  StartPreview(Gender: Gender): Promise<void> {
    return this.Post('CharacterPreviewStart', { Gender });
  }

  ApplyAppearance(Appearance: AppearanceData): Promise<void> {
    return this.Post('CharacterPreviewApply', { Appearance });
  }

  ApplyOutfit(Outfit: OutfitData): Promise<void> {
    return this.Post('CharacterPreviewOutfit', { Outfit });
  }

  ApplyCamera(Camera: PreviewCamera): Promise<void> {
    return this.Post('CharacterPreviewCamera', { Camera });
  }

  StopPreview(): Promise<void> {
    return this.Post('CharacterPreviewStop', {});
  }
}

export const Preview = new PreviewClient();
