<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Popover from 'primevue/popover';
import Slider from 'primevue/slider';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDice,
  IconPalette,
} from '@tabler/icons-vue';
import {
  CameraSliders,
  RandomSliderValues,
  type OverlayName,
  type SliderDef,
} from '@Shared/Constants/Character';
import { ClothingCategories } from '@Shared/Constants/Outfit';
import { useCharacterStore } from '@/Stores/Character';
import { Preview } from '@/Services/PreviewClient';

/**
 * Slider Id -> outfit category metadata. Lets the wizard detect "this is
 * an outfit slider" in O(1) and resolve whether it drives the Drawable
 * or the Texture axis without re-parsing the slider Id string.
 */
type OutfitSliderKind = 'Drawable' | 'Texture';
interface OutfitSliderMeta {
  CategoryId: string;
  Kind: OutfitSliderKind;
}
const OutfitSliderIndex: Record<string, OutfitSliderMeta> = (() => {
  const Index: Record<string, OutfitSliderMeta> = {};
  for (const Category of ClothingCategories) {
    Index[`${Category.Id}_Drawable`] = { CategoryId: Category.Id, Kind: 'Drawable' };
    Index[`${Category.Id}_Texture`] = { CategoryId: Category.Id, Kind: 'Texture' };
  }
  return Index;
})();

const Char = useCharacterStore();
const Router = useRouter();

const RootEl = useTemplateRef<HTMLElement>('RootEl');
const OpacityPopover = useTemplateRef<InstanceType<typeof Popover>>('OpacityPopover');
const PopoverOverlay = ref<OverlayName | null>(null);

const CurrentPage = computed(() => Char.Pages[Char.CurrentPageIndex]);
const IsFirstPage = computed(() => Char.CurrentPageIndex === 0);
const IsFinalPage = computed(() => Char.CurrentPageIndex === Char.Pages.length - 1);
const ShowFinishConfirm = ref(false);

function SetActiveSlider(Id: string): void {
  Char.ActiveSliderId = Id;
}

function ValueOf(Id: string): number {
  return Char.SliderValues[Id] ?? 0;
}

/**
 * Resolve the runtime Max for a slider. Outfit Drawable sliders read the
 * per-category DrawableMax from the bounds map (pushed by the Frontend
 * after the model loads); outfit Texture sliders read the
 * TextureMaxByDrawable entry for the currently-selected drawable. Any
 * other slider falls back to its static SliderDef.Max.
 */
function LiveMax(Def: SliderDef): number {
  const Meta = OutfitSliderIndex[Def.Id];
  if (Meta === undefined) return Def.Max;
  const Bounds = Char.OutfitBounds[Meta.CategoryId];
  if (Bounds === undefined) return Def.Max;
  if (Meta.Kind === 'Drawable') return Math.max(Def.Min, Bounds.DrawableMax);
  const DrawableValue = ValueOf(`${Meta.CategoryId}_Drawable`);
  // Drawable -1 (no prop equipped) has no texture variants; pin the
  // Texture slider at 0 so the row reads "Texture 0 / 0" rather than a
  // stale max carried over from a previous drawable.
  if (DrawableValue < 0) return 0;
  const TextureMax = Bounds.TextureMaxByDrawable[DrawableValue];
  return typeof TextureMax === 'number' ? TextureMax : 0;
}

function IsOutfitSlider(Def: SliderDef): boolean {
  return OutfitSliderIndex[Def.Id] !== undefined;
}

function DisplayValue(Def: SliderDef): string {
  const Value = ValueOf(Def.Id);
  if (IsOutfitSlider(Def)) {
    // Drawable / Texture rows show "N / Max" - GTA component variants
    // have no canonical names, so the raw index plus the live max is
    // the clearest hint the player has about where they sit in the set.
    return `${Math.round(Value)} / ${LiveMax(Def)}`;
  }
  if (Def.ValueLabels !== undefined) {
    const Index = Math.round(Value);
    const Hit = Def.ValueLabels[Index];
    if (typeof Hit === 'string') return Hit;
  }
  if (Def.Step < 1) return Value.toFixed(2);
  return String(Math.round(Value));
}

function ApplyLivePreview(Def: SliderDef): void {
  if (IsOutfitSlider(Def)) {
    void Preview.ApplyOutfit(Char.Outfit);
    return;
  }
  void Preview.ApplyAppearance(Char.Appearance);
}

function SetSlider(Id: string, Raw: number | number[], Def: SliderDef): void {
  const Value = Array.isArray(Raw) ? (Raw[0] ?? 0) : Raw;
  Char.SetSlider(Id, Value);
  ApplyLivePreview(Def);
}

function AdjustSlider(Def: SliderDef, Direction: -1 | 1): void {
  const Current = ValueOf(Def.Id);
  const Max = LiveMax(Def);
  const Next = Math.min(Max, Math.max(Def.Min, Current + Def.Step * Direction));
  Char.SetSlider(Def.Id, +Next.toFixed(6));
  ApplyLivePreview(Def);
}

function SetCameraSlider(Id: string, Raw: number | number[]): void {
  const Value = Array.isArray(Raw) ? (Raw[0] ?? 0) : Raw;
  Char.SetSlider(Id, Value);
  void Preview.ApplyCamera(Char.Camera);
}

function AdjustCameraSlider(Def: SliderDef, Direction: -1 | 1): void {
  const Current = ValueOf(Def.Id);
  const Next = Math.min(Def.Max, Math.max(Def.Min, Current + Def.Step * Direction));
  Char.SetSlider(Def.Id, +Next.toFixed(6));
  void Preview.ApplyCamera(Char.Camera);
}

function OpenOpacityPopover(Event: MouseEvent, Def: SliderDef): void {
  if (Def.HasOpacity !== true) return;
  PopoverOverlay.value = Def.Id as OverlayName;
  OpacityPopover.value?.show(Event);
}

function SetOpacity(Raw: number | number[]): void {
  if (PopoverOverlay.value === null) return;
  const Value = Array.isArray(Raw) ? (Raw[0] ?? 0) : Raw;
  Char.SetSlider(`${PopoverOverlay.value}Opacity`, Value);
  void Preview.ApplyAppearance(Char.Appearance);
}

function Randomize(): void {
  const Next = RandomSliderValues(Char.Gender);
  // Preserve camera framing - the player's current viewing angle should
  // survive a randomize.
  for (const Sld of CameraSliders) {
    Next[Sld.Id] = ValueOf(Sld.Id);
  }
  // Preserve outfit selections too. RandomSliderValues writes the
  // outfit sliders' DefaultValues (drawable 0 / texture 0; -1 for
  // props) because they lack RandomMin/RandomMax, which would wipe
  // any wardrobe choices the player has already made. The Randomize
  // button on the Heritage page is meant to reroll appearance, not
  // strip clothing.
  for (const Category of ClothingCategories) {
    const DrawableKey = `${Category.Id}_Drawable`;
    const TextureKey = `${Category.Id}_Texture`;
    Next[DrawableKey] = ValueOf(DrawableKey);
    Next[TextureKey] = ValueOf(TextureKey);
  }
  Char.ReplaceSliderValues(Next);
  void Preview.ApplyAppearance(Char.Appearance);
}

function OnBack(): void {
  if (IsFirstPage.value) {
    void Preview.StopPreview();
    Router.replace('/Character/Details').catch(() => {
      /* navigation guard cancels are silent */
    });
    return;
  }
  Char.GoBack();
}

function OnNext(): void {
  if (IsFinalPage.value) {
    ShowFinishConfirm.value = true;
    return;
  }
  Char.GoNext();
}

function ConfirmFinish(): void {
  if (Char.Status === 'Submitting') return;
  ShowFinishConfirm.value = false;
  Char.BeginSubmit();
  void fetch('https://roleplay/CharacterCreate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      FirstName: Char.FirstName,
      LastName: Char.LastName,
      Age: Char.Age,
      Gender: Char.Gender,
      BloodType: Char.BloodType,
      HeightCm: Char.HeightCm,
      WeightKg: Char.WeightKg,
      Appearance: Char.Appearance,
      Outfit: Char.Outfit,
    }),
  }).catch((Err: unknown) => {
    Char.HandleFailure(`Could not contact the server: ${String(Err)}`);
  });
}

function FindSliderDef(Id: string): SliderDef | null {
  for (const Def of CurrentPage.value?.Sliders ?? []) {
    if (Def.Id === Id) return Def;
  }
  for (const Def of CameraSliders) {
    if (Def.Id === Id) return Def;
  }
  return null;
}

function IsTypingTarget(Target: EventTarget | null): boolean {
  if (!(Target instanceof HTMLElement)) return false;
  const Tag = Target.tagName;
  return Tag === 'INPUT' || Tag === 'TEXTAREA' || Target.isContentEditable;
}

function HandleKeydown(Event: KeyboardEvent): void {
  if (IsTypingTarget(Event.target)) return;
  if (Char.ActiveSliderId === null) return;

  const Dir = Event.key === 'ArrowRight' ? 1 : Event.key === 'ArrowLeft' ? -1 : 0;
  if (Dir === 0) return;

  const Def = FindSliderDef(Char.ActiveSliderId);
  if (Def === null) return;

  Event.preventDefault();
  if (CameraSliders.includes(Def)) {
    AdjustCameraSlider(Def, Dir as -1 | 1);
  } else {
    AdjustSlider(Def, Dir as -1 | 1);
  }
}

onMounted(() => {
  void Preview.StartPreview(Char.Gender).then(() => {
    void Preview.ApplyAppearance(Char.Appearance);
    void Preview.ApplyOutfit(Char.Outfit);
    void Preview.ApplyCamera(Char.Camera);
  });

  document.addEventListener('keydown', HandleKeydown);
  nextTick(() => RootEl.value?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', HandleKeydown);
  // StopPreview teleports the ped back to the auth skybox via
  // RestoreAuthShell - only fire it when the user is backing out
  // of the wizard. Submit-in-flight ('Submitting') and post-spawn
  // ('Spawned') both leave teardown to the spawn pipeline.
  if (Char.Status === 'Editing' || Char.Status === 'Failed') {
    void Preview.StopPreview();
  }
});
</script>

<template>
  <main
    ref="RootEl"
    tabindex="-1"
    class="CreatorRoot"
  >
    <!-- Top title bar -->
    <Card class="TopBar">
      <template #content>
        <h1 class="TopBarTitle">Character Creator</h1>
      </template>
    </Card>

    <!-- Wizard panel (left) -->
    <Card class="WizardCard">
      <template #header>
        <div class="WizardHeader">
          <h2 class="PageName">{{ CurrentPage?.Name }}</h2>
          <p class="StepCounter">
            Step {{ Char.CurrentPageIndex + 1 }} of {{ Char.Pages.length }}
          </p>
        </div>
      </template>
      <template #content>
        <div class="SliderList">
          <div
            v-for="Def in CurrentPage?.Sliders ?? []"
            :key="Def.Id"
            class="SliderRow"
            :class="{ ActiveSlider: Char.ActiveSliderId === Def.Id }"
            @mousedown="SetActiveSlider(Def.Id)"
          >
            <div class="SliderRowHead">
              <label :for="Def.Id" class="SliderLabel">{{ Def.Label }}</label>
              <div class="SliderValue">
                <span class="SliderValueText">{{ DisplayValue(Def) }}</span>
                <button
                  v-if="Def.HasOpacity"
                  type="button"
                  class="OpacityToggle"
                  :aria-label="`Adjust ${Def.Label} opacity`"
                  @click="OpenOpacityPopover($event, Def)"
                >
                  <IconPalette :size="16" />
                </button>
              </div>
            </div>
            <div class="SliderRowControls">
              <Button
                severity="secondary"
                text
                rounded
                size="small"
                :aria-label="`${Def.Label} decrease`"
                @click="AdjustSlider(Def, -1)"
              >
                <template #icon><IconChevronLeft :size="16" /></template>
              </Button>
              <Slider
                :id="Def.Id"
                :model-value="ValueOf(Def.Id)"
                :min="Def.Min"
                :max="LiveMax(Def)"
                :step="Def.Step"
                class="SliderTrack"
                @update:model-value="(V: number | number[]) => SetSlider(Def.Id, V, Def)"
              />
              <Button
                severity="secondary"
                text
                rounded
                size="small"
                :aria-label="`${Def.Label} increase`"
                @click="AdjustSlider(Def, 1)"
              >
                <template #icon><IconChevronRight :size="16" /></template>
              </Button>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="WizardFooter">
          <Button
            v-if="IsFirstPage"
            severity="danger"
            label="Randomize"
            @click="Randomize"
          >
            <template #icon><IconDice :size="16" /></template>
          </Button>
          <Button
            v-else
            severity="secondary"
            label="Back"
            @click="OnBack"
          >
            <template #icon><IconArrowLeft :size="16" /></template>
          </Button>
          <Button
            :severity="IsFinalPage ? 'success' : 'primary'"
            :label="IsFinalPage ? 'Finish' : 'Next'"
            :icon-pos="IsFinalPage ? 'left' : 'right'"
            :loading="Char.Status === 'Submitting'"
            :disabled="Char.Status === 'Submitting'"
            @click="OnNext"
          >
            <template #icon>
              <IconCheck v-if="IsFinalPage" :size="16" />
              <IconArrowRight v-else :size="16" />
            </template>
          </Button>
        </div>
        <button
          v-if="IsFirstPage"
          type="button"
          class="BackToDetails"
          @click="OnBack"
        >
          Back to details
        </button>
      </template>
    </Card>

    <!-- Preview Controls panel (right) -->
    <Card class="PreviewCard">
      <template #header>
        <div class="WizardHeader">
          <h3 class="PageName">Preview Controls</h3>
        </div>
      </template>
      <template #content>
        <div class="SliderList">
          <div
            v-for="Def in CameraSliders"
            :key="Def.Id"
            class="SliderRow"
            :class="{ ActiveSlider: Char.ActiveSliderId === Def.Id }"
            @mousedown="SetActiveSlider(Def.Id)"
          >
            <div class="SliderRowHead">
              <label :for="Def.Id" class="SliderLabel">{{ Def.Label }}</label>
              <span class="SliderValueText">{{ DisplayValue(Def) }}</span>
            </div>
            <div class="SliderRowControls">
              <Button
                severity="secondary"
                text
                rounded
                size="small"
                :aria-label="`${Def.Label} decrease`"
                @click="AdjustCameraSlider(Def, -1)"
              >
                <template #icon><IconChevronLeft :size="16" /></template>
              </Button>
              <Slider
                :id="Def.Id"
                :model-value="ValueOf(Def.Id)"
                :min="Def.Min"
                :max="Def.Max"
                :step="Def.Step"
                class="SliderTrack"
                @update:model-value="(V: number | number[]) => SetCameraSlider(Def.Id, V)"
              />
              <Button
                severity="secondary"
                text
                rounded
                size="small"
                :aria-label="`${Def.Label} increase`"
                @click="AdjustCameraSlider(Def, 1)"
              >
                <template #icon><IconChevronRight :size="16" /></template>
              </Button>
            </div>
          </div>
        </div>
      </template>
    </Card>

    <!-- Failure banner -->
    <Message
      v-if="Char.Reason"
      severity="error"
      :closable="false"
      class="ErrorBanner"
    >
      {{ Char.Reason }}
    </Message>

    <!-- Opacity popover -->
    <Popover ref="OpacityPopover">
      <div v-if="PopoverOverlay !== null" class="OpacityPopover">
        <h4 class="OpacityHeading">Opacity</h4>
        <div class="OpacityControl">
          <span class="OpacityValue">
            {{ Char.SliderValues[`${PopoverOverlay}Opacity`] ?? 100 }}
          </span>
          <Slider
            :model-value="Char.SliderValues[`${PopoverOverlay}Opacity`] ?? 100"
            :min="0"
            :max="100"
            :step="1"
            class="SliderTrack"
            @update:model-value="SetOpacity"
          />
        </div>
      </div>
    </Popover>

    <!-- Confirm: finish creation -->
    <Dialog
      v-model:visible="ShowFinishConfirm"
      header="Confirm"
      modal
      :style="{ width: '24rem' }"
    >
      <p class="DialogText">Are you sure you are finished?</p>
      <template #footer>
        <Button label="No" severity="secondary" @click="ShowFinishConfirm = false" />
        <Button label="Yes" @click="ConfirmFinish" />
      </template>
    </Dialog>
  </main>
</template>

<style scoped>
.CreatorRoot {
  position: relative;
  width: 100vw;
  min-height: 100vh;
  outline: none;
}

.TopBar {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  min-width: 14rem;
}

.TopBarTitle {
  margin: 0;
  text-align: center;
  font-size: 1rem;
  font-weight: 600;
}

.WizardCard {
  position: absolute;
  left: 2rem;
  top: 5.5rem;
  width: 28rem;
  max-width: 40vw;
  max-height: calc(100vh - 7rem);
  display: flex;
  flex-direction: column;
}

.PreviewCard {
  position: absolute;
  right: 2rem;
  top: 5.5rem;
  width: 22rem;
  max-width: 35vw;
}

.WizardHeader {
  padding: 1rem 1.25rem 0.5rem;
  text-align: center;
}

.PageName {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.StepCounter {
  margin: 0.125rem 0 0 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.SliderList {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.SliderRow {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem;
  border-radius: var(--p-content-border-radius);
  transition: background 0.12s ease;
}

.SliderRow.ActiveSlider {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--p-primary-color) 60%, transparent);
}

.SliderRowHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.SliderLabel {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--p-text-color);
}

.SliderValue {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.SliderValueText {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
}

.OpacityToggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  padding: 0.125rem;
  cursor: pointer;
  color: var(--p-text-muted-color);
  transition: color 0.12s ease;
}

.OpacityToggle:hover {
  color: var(--p-primary-color);
}

.SliderRowControls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.SliderTrack {
  flex: 1;
}

.WizardFooter {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.BackToDetails {
  display: block;
  margin: 0.5rem auto 0;
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  cursor: pointer;
  text-decoration: none;
  transition: color 0.12s ease;
}

.BackToDetails:hover {
  color: var(--p-primary-color);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ErrorBanner {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  max-width: 32rem;
}

.OpacityPopover {
  width: 18rem;
  padding: 0.5rem;
}

.OpacityHeading {
  margin: 0 0 0.5rem 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--p-text-color);
}

.OpacityControl {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.OpacityValue {
  width: 2.5rem;
  text-align: right;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
}

.DialogText {
  margin: 0;
  color: var(--p-text-color);
}
</style>
