import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import App from '@/App.vue';
import { Router } from '@/Router';
import { NuiInbox } from '@/Services/NuiInbox';
import { InitializeTheme } from '@/Services/Theme';

// Read the user's saved theme choice (or default to System) and apply
// the `.dark` class to `<html>` BEFORE the SPA mounts, so the first
// paint is already in the right palette.
InitializeTheme();
// Inter, self-hosted via @fontsource so CEF doesn't need to hit Google
// Fonts on every connect. Four weights cover headings -> body text.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@/Style.css';

const Application = createApp(App);

Application.use(createPinia());
Application.use(Router);
Application.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark',
      cssLayer: {
        name: 'primevue',
        order: 'tailwind-base, primevue, tailwind-utilities',
      },
    },
  },
});

Application.mount('#App');

// Start listening for Frontend -> UI NUI messages once the router exists.
const Inbox = new NuiInbox(Router);
Inbox.Start();

// Handshake: tell the Frontend the SPA is mounted and the inbox is live.
// SendNUIMessage calls made before this round-trip are silently dropped by
// FiveM (no native queueing), so the Frontend defers all sends behind this
// signal. Outside CEF the fetch fails silently and the SPA still renders
// (useful for `npm run dev`).
try {
  void fetch('https://roleplay/NuiReady', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
} catch {
  // not in CEF; ignore
}
