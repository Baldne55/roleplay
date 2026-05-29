<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Card from 'primevue/card';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import {
  IconArrowRight,
  IconCalendar,
  IconRuler,
  IconUser,
  IconUserCircle,
  IconWeight,
  IconX,
} from '@tabler/icons-vue';
import {
  BloodTypes,
  Genders,
  MaxAge,
  MaxHeightCm,
  MaxWeightKg,
  MinAge,
  MinHeightCm,
  MinWeightKg,
  NameMaxLength,
  NameMinLength,
} from '@Shared/Constants/Character';
import { useCharacterStore } from '@/Stores/Character';
import { useCharacterListStore } from '@/Stores/CharacterList';

const Char = useCharacterStore();
const List = useCharacterListStore();
const Router = useRouter();

// Cancel is only meaningful when the account already owns at least one
// character - otherwise there's nowhere to land. Zero-character accounts
// have no Selector route to go back to (they're routed straight here on
// AuthCompleted), so the button stays hidden.
const CanCancel = computed<boolean>(() => List.HasCharacters);

function Continue(): void {
  if (!Char.DetailsValid) return;
  Router.push('/Character/Creator').catch(() => {
    /* navigation guard cancels are silent */
  });
}

function Cancel(): void {
  Char.ResetAll();
  Router.replace('/Character/Select').catch(() => {
    /* navigation guard cancels are silent */
  });
}
</script>

<template>
  <main class="DetailsRoot">
    <Card class="DetailsCard" role="dialog" aria-labelledby="DetailsHeadline">
      <template #header>
        <div class="DetailsHeader">
          <div class="DetailsHeaderIcon">
            <IconUserCircle :size="22" />
          </div>
          <div>
            <h1 id="DetailsHeadline" class="DetailsHeadline">New Character</h1>
            <p class="DetailsSubhead">
              Identity details first. Appearance is the next step.
            </p>
          </div>
        </div>
      </template>

      <template #content>
        <form class="DetailsForm" @submit.prevent="Continue">
          <div class="Row Cols2">
            <IconField>
              <InputIcon><IconUser :size="16" /></InputIcon>
              <InputText
                v-model="Char.FirstName"
                placeholder="First name"
                :maxlength="NameMaxLength"
                spellcheck="false"
                autofocus
                fluid
              />
            </IconField>
            <IconField>
              <InputIcon><IconUser :size="16" /></InputIcon>
              <InputText
                v-model="Char.LastName"
                placeholder="Last name"
                :maxlength="NameMaxLength"
                spellcheck="false"
                fluid
              />
            </IconField>
          </div>

          <fieldset class="FieldSet">
            <legend class="FieldLabel">Gender</legend>
            <SelectButton
              v-model="Char.Gender"
              :options="[...Genders]"
              :allow-empty="false"
              :pt="{ root: { class: 'GenderSelect' } }"
            />
          </fieldset>

          <fieldset class="FieldSet">
            <legend class="FieldLabel">Blood Type</legend>
            <SelectButton
              v-model="Char.BloodType"
              :options="[...BloodTypes]"
              :allow-empty="false"
              :pt="{ root: { class: 'BloodSelect' } }"
            />
          </fieldset>

          <div class="Field">
            <label for="AgeInput" class="FieldLabel">Age</label>
            <IconField>
              <InputIcon><IconCalendar :size="16" /></InputIcon>
              <InputNumber
                id="AgeInput"
                v-model="Char.Age"
                :placeholder="`${MinAge}-${MaxAge}`"
                :min="MinAge"
                :max="MaxAge"
                :use-grouping="false"
                show-buttons
                button-layout="horizontal"
                fluid
              />
            </IconField>
          </div>
          <div class="Field">
            <label for="HeightInput" class="FieldLabel">Height cm</label>
            <IconField>
              <InputIcon><IconRuler :size="16" /></InputIcon>
              <InputNumber
                id="HeightInput"
                v-model="Char.HeightCm"
                :placeholder="`${MinHeightCm}-${MaxHeightCm}`"
                :min="MinHeightCm"
                :max="MaxHeightCm"
                :use-grouping="false"
                show-buttons
                button-layout="horizontal"
                fluid
              />
            </IconField>
          </div>
          <div class="Field">
            <label for="WeightInput" class="FieldLabel">Weight kg</label>
            <IconField>
              <InputIcon><IconWeight :size="16" /></InputIcon>
              <InputNumber
                id="WeightInput"
                v-model="Char.WeightKg"
                :placeholder="`${MinWeightKg}-${MaxWeightKg}`"
                :min="MinWeightKg"
                :max="MaxWeightKg"
                :use-grouping="false"
                show-buttons
                button-layout="horizontal"
                fluid
              />
            </IconField>
          </div>

          <p class="HelperText">
            Names: English letters only, capitalised, {{ NameMinLength }}-{{ NameMaxLength }} characters.
          </p>

          <div class="ActionRow" :class="{ ActionRowSplit: CanCancel }">
            <Button
              v-if="CanCancel"
              type="button"
              severity="secondary"
              label="Cancel"
              fluid
              @click="Cancel"
            >
              <template #icon><IconX :size="16" /></template>
            </Button>
            <Button
              type="submit"
              label="Continue"
              icon-pos="right"
              fluid
              :disabled="!Char.DetailsValid"
            >
              <template #icon><IconArrowRight :size="16" /></template>
            </Button>
          </div>
        </form>
      </template>
    </Card>
  </main>
</template>

<style scoped>
.DetailsRoot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1.5rem;
  background: rgba(0, 0, 0, 0.4);
}

.DetailsCard {
  width: 28rem;
}

.DetailsHeader {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem 0;
}

.DetailsHeaderIcon {
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

.DetailsHeadline {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
}

.DetailsSubhead {
  margin: 0.125rem 0 0 0;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
}

.DetailsForm {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.Row {
  display: grid;
  gap: 0.75rem;
}

.Cols2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.Cols3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.FieldSet {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 0;
  margin: 0;
  padding: 0;
}

.Field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.FieldLabel {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--p-text-color);
}

:deep(.GenderSelect),
:deep(.BloodSelect) {
  display: grid;
  width: 100%;
  gap: 0.5rem;
}

:deep(.GenderSelect) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

:deep(.BloodSelect) {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

:deep(.GenderSelect .p-togglebutton),
:deep(.BloodSelect .p-togglebutton) {
  border-radius: var(--p-content-border-radius);
}

.HelperText {
  margin: 0;
  text-align: center;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.ActionRow {
  display: grid;
  gap: 0.5rem;
}

.ActionRowSplit {
  grid-template-columns: 1fr 2fr;
}
</style>
