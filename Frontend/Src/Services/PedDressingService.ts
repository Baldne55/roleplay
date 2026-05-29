import {
  FaceFeatureNames,
  FaceFeatureNativeID,
  OverlayNames,
  OverlayNativeID,
  type AppearanceData,
  type Gender,
  type OverlayName,
} from '@Shared/Constants/Character.js';
import { HairDecalsByGender } from '@Shared/Constants/Barbershop.js';
import { ClothingCategories, type OutfitData } from '@Shared/Constants/Outfit.js';
import { Logger } from '@/Util/Logger.js';

declare function PlayerId(): number;
declare function PlayerPedId(): number;
declare function GetHashKey(Name: string): number;
declare function IsModelInCdimage(Model: number): boolean;
declare function RequestModel(Model: number): void;
declare function HasModelLoaded(Model: number): boolean;
declare function SetModelAsNoLongerNeeded(Model: number): void;
declare function SetPlayerModel(Player: number, Model: number): void;
declare function SetPedHeadBlendData(
  Ped: number,
  ShapeFirst: number,
  ShapeSecond: number,
  ShapeThird: number,
  SkinFirst: number,
  SkinSecond: number,
  SkinThird: number,
  ShapeMix: number,
  SkinMix: number,
  ThirdMix: number,
  IsParent: boolean,
): void;
declare function SetPedComponentVariation(
  Ped: number,
  Component: number,
  Drawable: number,
  Texture: number,
  Palette: number,
): void;
declare function SetPedHairColor(Ped: number, Color: number, Highlight: number): void;
declare function SetPedHeadOverlay(
  Ped: number,
  OverlayID: number,
  Index: number,
  Opacity: number,
): void;
declare function SetPedHeadOverlayColor(
  Ped: number,
  OverlayID: number,
  ColorType: number,
  Color: number,
  Highlight: number,
): void;
declare function SetPedFaceFeature(Ped: number, Index: number, Value: number): void;
declare function SetPedEyeColor(Ped: number, Index: number): void;
declare function ClearPedDecorations(Ped: number): void;
declare function AddPedDecorationFromHashes(
  Ped: number,
  CollectionHash: number,
  OverlayHash: number,
): void;
declare function ClearAllPedProps(Ped: number): void;
declare function SetPedPropIndex(
  Ped: number,
  Slot: number,
  Drawable: number,
  Texture: number,
  AttachPoint: boolean,
): void;
declare function ClearPedProp(Ped: number, Slot: number): void;

/**
 * GTA SetPedHeadOverlayColor ColorType per overlay slot. Hair-palette
 * overlays (eyebrows / facial hair / chest hair / body) use type 1;
 * makeup-palette overlays (lipstick / blush / makeup) use type 2.
 * Everything else uses type 1 with no visible effect.
 */
const OverlayColorType: Record<OverlayName, number> = {
  Blemishes: 1,
  FacialHair: 1,
  Eyebrows: 1,
  Ageing: 1,
  Makeup: 2,
  Blush: 2,
  Complexion: 1,
  SunDamage: 1,
  Lipstick: 2,
  MolesFreckles: 1,
  ChestHair: 1,
  BodyBlemishes: 1,
  AddBodyBlemishes: 1,
};

/**
 * Reusable ped-dressing operations: model swap, the head-blend / overlay
 * / face-feature reset that primes a freshly-loaded freemode ped, and
 * the appearance + outfit apply paths.
 *
 * Used by both the character creator (live preview) and the spawn-into-
 * world flow (post-Select / post-Create). Sharing this service avoids a
 * SpawnService<->CharacterCreatorService circular dependency.
 *
 * `CurrentGender` is the gender of whichever model is currently loaded;
 * callers that depend on it for hair-decal lookup (ApplyAppearance) must
 * either be called via this service or call LoadAndSetModel first so the
 * field is populated.
 */
export class PedDressingService {
  private readonly Log = Logger.New('PedDressing');
  private CurrentGender: Gender | null = null;

  GetCurrentGender(): Gender | null {
    return this.CurrentGender;
  }

  /**
   * Swap the local player ped to the freemode model for the given gender.
   * Promise resolves once the model finishes streaming in. Subsequent
   * native calls (ApplyAppearance / ApplyOutfit) target the new ped.
   */
  async LoadAndSetModel(Gender: Gender): Promise<void> {
    const ModelName = Gender === 'Male' ? 'mp_m_freemode_01' : 'mp_f_freemode_01';
    const Model = GetHashKey(ModelName);
    if (!IsModelInCdimage(Model)) {
      throw new Error(`Model ${ModelName} is not in cdimage`);
    }
    RequestModel(Model);
    await new Promise<void>((Resolve) => {
      const Poll = (): void => {
        if (HasModelLoaded(Model)) {
          SetPlayerModel(PlayerId(), Model);
          SetModelAsNoLongerNeeded(Model);
          Resolve();
          return;
        }
        setTimeout(Poll, 50);
      };
      Poll();
    });
    this.CurrentGender = Gender;
    this.Log.Debug(`Model loaded - ${ModelName}`);
  }

  /**
   * Prime the head-blend / overlay / face-feature slots on a freshly-
   * loaded freemode ped. Without this, the ped has UNDEFINED head-blend
   * state and subsequent SetPedHeadBlendData calls silently no-op until
   * the slot is initialised. Mirrors ragemp's `resetLocalPlayerAppearance`
   * prelude.
   *
   * Also clears decorations + props so a previous identity's hair decal
   * / hat doesn't bleed into the new ped.
   */
  ResetForFreshFreemodePed(Ped: number): void {
    ClearPedDecorations(Ped);
    ClearAllPedProps(Ped);

    SetPedHeadBlendData(Ped, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0, false);
    for (let I = 0; I < 13; I += 1) {
      SetPedHeadOverlay(Ped, I, 255, 0);
    }
    for (let I = 0; I < 20; I += 1) {
      SetPedFaceFeature(Ped, I, 0);
    }
    SetPedEyeColor(Ped, 0);
    SetPedHairColor(Ped, 0, 0);
  }

  /**
   * Apply a full AppearanceData to the local ped. Idempotent - safe to
   * re-call as sliders change in the creator, or once on spawn.
   */
  ApplyAppearance(Data: AppearanceData): void {
    const Ped = PlayerPedId();
    const H = Data.Heritage;

    SetPedHeadBlendData(
      Ped,
      H.ShapeParents[0],
      H.ShapeParents[1],
      H.ShapeParents[2],
      H.SkinParents[0],
      H.SkinParents[1],
      H.SkinParents[2],
      H.ShapeMix,
      H.SkinMix,
      H.OverrideMix,
      false,
    );

    // Hair drawable is component slot 2; texture 0, palette 0 - dye /
    // colour are applied via SetPedHairColor.
    SetPedComponentVariation(Ped, 2, Data.Hair.Style, 0, 0);
    SetPedHairColor(Ped, Data.Hair.Color, Data.Hair.Highlight);

    // Hair decals (scalp tattoos) re-apply per call - the native is
    // additive, so any prior decoration must be cleared first or the
    // ped accumulates overlapping scalps as the slider changes.
    ClearPedDecorations(Ped);
    if (Data.Hair.Decal.Index !== 255 && this.CurrentGender !== null) {
      const Decals = HairDecalsByGender(this.CurrentGender);
      const Entry = Decals[Data.Hair.Decal.Index];
      if (Entry !== undefined) {
        AddPedDecorationFromHashes(
          Ped,
          GetHashKey(Entry.Collection),
          GetHashKey(Entry.Overlay),
        );
      }
    }

    SetPedEyeColor(Ped, Data.EyeColor);

    for (const Name of FaceFeatureNames) {
      SetPedFaceFeature(Ped, FaceFeatureNativeID(Name), Data.FaceFeatures[Name]);
    }

    for (const Name of OverlayNames) {
      const Slot = Data.Overlays[Name];
      SetPedHeadOverlay(Ped, OverlayNativeID[Name], Slot.Index, Slot.Opacity);
      SetPedHeadOverlayColor(
        Ped,
        OverlayNativeID[Name],
        OverlayColorType[Name],
        Slot.Color,
        Slot.Color,
      );
    }
  }

  /**
   * Apply a full OutfitData to the local ped. Components write via
   * SetPedComponentVariation; props with Drawable >= 0 write via
   * SetPedPropIndex, and Drawable = -1 maps to ClearPedProp.
   */
  ApplyOutfit(Data: OutfitData): void {
    const Ped = PlayerPedId();
    for (const Category of ClothingCategories) {
      if (Category.Type === 'Component') {
        const Slot = Data.Components[Category.Id];
        if (Slot === undefined) continue;
        SetPedComponentVariation(Ped, Category.Index, Slot.Drawable, Slot.Texture, 0);
        continue;
      }
      const Slot = Data.Props[Category.Id];
      if (Slot === undefined) continue;
      if (Slot.Drawable < 0) {
        ClearPedProp(Ped, Category.Index);
        continue;
      }
      // AttachPoint=true matches every legacy outfit-shop callsite -
      // the native re-attaches the prop bone using the drawable's
      // configured offset and the prop slot itself decides where it
      // hangs (head / wrist / etc.).
      SetPedPropIndex(Ped, Category.Index, Slot.Drawable, Slot.Texture, true);
    }
  }
}
