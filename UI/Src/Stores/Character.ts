import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  AppearanceToSliderValues,
  BloodTypes,
  BuildCreatorPages,
  DefaultAppearanceData,
  Genders,
  MaxAge,
  MaxHeightCm,
  MaxWeightKg,
  MinAge,
  MinHeightCm,
  MinWeightKg,
  NameMaxLength,
  NameMinLength,
  NameRegex,
  OutfitToSliderValues,
  SliderValuesToAppearance,
  SliderValuesToOutfit,
  type AppearanceData,
  type BloodType,
  type Gender,
  type PageDef,
  type PreviewCamera,
  type SliderValues,
} from '@Shared/Constants/Character';
import { DefaultOutfitData, type OutfitData } from '@Shared/Constants/Outfit';

/**
 * Per-category outfit slider bounds pushed from the Frontend after the
 * freemode model loads. The UI clamps slider maxima at render time so
 * each Drawable / Texture slider only walks valid GTA V variations.
 */
export interface OutfitCategoryBounds {
  DrawableMax: number;
  TextureMaxByDrawable: number[];
}
/** Per-category clothing bounds the Frontend reports once the ped model has loaded. */
export type OutfitBoundsMap = Record<string, OutfitCategoryBounds>;

/**
 * Wizard submit lifecycle.
 *
 *   Editing    - default; user is filling the form.
 *   Submitting - POST in flight, waiting on server confirmation.
 *   Spawned    - server accepted + auto-spawn handed off; the SPA is
 *                about to unmount in favour of /InWorld. Distinct from
 *                Editing so CreatorView's onBeforeUnmount does NOT call
 *                StopPreview (which would teleport the freshly-spawned
 *                ped back to the auth skybox).
 *   Failed     - server rejected; user retries from the form.
 */
export type CreateStatus = 'Editing' | 'Submitting' | 'Spawned' | 'Failed';

/**
 * In-progress character-creation form + appearance.
 *
 *   - `Details`: filled on Step 1 (DetailsView). Validated client-side
 *     for instant feedback; server is the source of truth.
 *   - `SliderValues`: flat record keyed by `SliderDef.Id`, driven by
 *     the wizard. `Appearance` is a typed-AppearanceData view computed
 *     from SliderValues, used for the Frontend preview + submit.
 *   - `Camera`: typed PreviewCamera view derived from camera-slider
 *     entries in SliderValues.
 *
 *   `CurrentPageIndex` drives the wizard chrome; `Status` + `Reason`
 *   surface submit feedback.
 */
export const UseCharacterStore = defineStore('Character', () => {
  const FirstName = ref<string>('');
  const LastName = ref<string>('');
  const Age = ref<number>(MinAge);
  const Gender = ref<Gender>('Male');
  const BloodType = ref<BloodType>('O+');
  const HeightCm = ref<number>(180);
  const WeightKg = ref<number>(80);

  const SliderValues = reactive<SliderValues>({
    ...AppearanceToSliderValues(DefaultAppearanceData()),
    ...OutfitToSliderValues(DefaultOutfitData()),
  });

  /**
   * Per-category drawable / texture bounds. Seeded empty so first paint
   * before the Frontend pushes real bounds keeps the sliders parked at
   * their placeholder Min/Max from the SliderDef catalog.
   */
  const OutfitBounds = ref<OutfitBoundsMap>({});

  /**
   * Gender-aware wizard page list. Switches the Hair-decal label catalog
   * and adds the Male-only Facial Hair / Chest Hair pages.
   */
  const Pages = computed<PageDef[]>(() => BuildCreatorPages(Gender.value));

  /** Typed-AppearanceData view, recomputed when any slider value changes. */
  const Appearance = computed<AppearanceData>(() =>
    SliderValuesToAppearance(SliderValues),
  );

  /** Typed-OutfitData view, recomputed when any outfit slider changes. */
  const Outfit = computed<OutfitData>(() => SliderValuesToOutfit(SliderValues));

  /** Typed-PreviewCamera view derived from the four camera sliders. */
  const Camera = computed<PreviewCamera>(() => ({
    Rotation: SliderValues.CameraRotation ?? 0,
    Zoom: SliderValues.CameraZoom ?? 0,
    Height: SliderValues.CameraHeight ?? 0,
    Slide: SliderValues.CameraSlide ?? 0,
  }));

  const CurrentPageIndex = ref<number>(0);
  const ActiveSliderId = ref<string | null>(null);
  const Status = ref<CreateStatus>('Editing');
  const Reason = ref<string | null>(null);

  const DetailsValid = computed<boolean>(
    () =>
      NameRegex.test(FirstName.value) &&
      FirstName.value.length >= NameMinLength &&
      FirstName.value.length <= NameMaxLength &&
      NameRegex.test(LastName.value) &&
      LastName.value.length >= NameMinLength &&
      LastName.value.length <= NameMaxLength &&
      Number.isInteger(Age.value) &&
      Age.value >= MinAge &&
      Age.value <= MaxAge &&
      Genders.includes(Gender.value) &&
      BloodTypes.includes(BloodType.value) &&
      Number.isInteger(HeightCm.value) &&
      HeightCm.value >= MinHeightCm &&
      HeightCm.value <= MaxHeightCm &&
      Number.isInteger(WeightKg.value) &&
      WeightKg.value >= MinWeightKg &&
      WeightKg.value <= MaxWeightKg,
  );

  function SetSlider(Id: string, Value: number): void {
    SliderValues[Id] = Value;
  }

  function ReplaceSliderValues(Next: SliderValues): void {
    for (const Key of Object.keys(SliderValues)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- clearing a reactive record in place so Vue tracks the removals
      delete SliderValues[Key];
    }
    Object.assign(SliderValues, Next);
  }

  function SetOutfitBounds(Bounds: OutfitBoundsMap): void {
    OutfitBounds.value = Bounds;
  }

  function ResetAll(): void {
    FirstName.value = '';
    LastName.value = '';
    Age.value = MinAge;
    Gender.value = 'Male';
    BloodType.value = 'O+';
    HeightCm.value = 180;
    WeightKg.value = 80;
    ReplaceSliderValues({
      ...AppearanceToSliderValues(DefaultAppearanceData()),
      ...OutfitToSliderValues(DefaultOutfitData()),
    });
    OutfitBounds.value = {};
    CurrentPageIndex.value = 0;
    ActiveSliderId.value = null;
    Status.value = 'Editing';
    Reason.value = null;
  }

  function SetPageIndex(Index: number): void {
    const Clamped = Math.max(0, Math.min(Pages.value.length - 1, Index));
    CurrentPageIndex.value = Clamped;
  }

  function GoNext(): boolean {
    if (CurrentPageIndex.value >= Pages.value.length - 1) return false;
    CurrentPageIndex.value += 1;
    return true;
  }

  function GoBack(): boolean {
    if (CurrentPageIndex.value <= 0) return false;
    CurrentPageIndex.value -= 1;
    return true;
  }

  function BeginSubmit(): void {
    Status.value = 'Submitting';
    Reason.value = null;
  }

  /**
   * Server accepted the create + chained auto-spawn. The route will flip
   * to /InWorld shortly; this status tells the CreatorView unmount path
   * to skip its StopPreview teardown (the spawn already replaced the
   * ped's coord + camera).
   */
  function MarkSpawned(): void {
    Status.value = 'Spawned';
    Reason.value = null;
  }

  function HandleFailure(Why: string): void {
    Status.value = 'Failed';
    Reason.value = Why;
  }

  return {
    FirstName,
    LastName,
    Age,
    Gender,
    BloodType,
    HeightCm,
    WeightKg,
    SliderValues,
    OutfitBounds,
    Pages,
    Appearance,
    Outfit,
    Camera,
    CurrentPageIndex,
    ActiveSliderId,
    Status,
    Reason,
    DetailsValid,
    SetSlider,
    ReplaceSliderValues,
    SetOutfitBounds,
    ResetAll,
    SetPageIndex,
    GoNext,
    GoBack,
    BeginSubmit,
    MarkSpawned,
    HandleFailure,
  };
});
