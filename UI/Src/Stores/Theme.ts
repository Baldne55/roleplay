import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  ApplyTheme,
  GetMode,
  ResolveIsDark,
  SetMode as ServiceSetMode,
  type ThemeMode,
} from '@/Services/Theme';

/**
 * Reactive view of the current theme mode. Wraps the imperative
 * `Services/Theme` so views can `v-model` against it. `InitializeTheme`
 * runs in Main.ts before this store is touched, so `Initial` here just
 * mirrors what's already applied to `<html>`.
 */
export const useThemeStore = defineStore('Theme', () => {
  const Mode = ref<ThemeMode>(GetMode());
  const IsDark = computed<boolean>(() => ResolveIsDark(Mode.value));

  function Set(Next: ThemeMode): void {
    Mode.value = Next;
    ServiceSetMode(Next);
    // Re-apply explicitly so System -> Light/Dark transitions paint
    // immediately even if the matchMedia listener hasn't fired.
    ApplyTheme(Next);
  }

  return { Mode, IsDark, Set };
});
