import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';

/**
 * SPA routes. `/Hidden` is the default mount - invisible, no styling - so
 * the SPA is loaded and listening for NUI messages without painting over
 * the game scene until a controller routes us elsewhere.
 *
 * Feature routes (Auth, CharacterSelect, etc.) land here when their views
 * are built.
 */
const Routes: RouteRecordRaw[] = [
  // In dev (`npm run dev`) we land on /Auth so the card is visible without
  // needing a FiveM SendNUIMessage to flip the route. In the CEF build
  // we land on /Hidden and wait for the AuthShow message as normal.
  { path: '/', redirect: import.meta.env.DEV ? '/Auth' : '/Hidden' },
  { path: '/Hidden', name: 'Hidden', component: () => import('@/Views/HiddenView.vue') },
  { path: '/Auth', name: 'Auth', component: () => import('@/Views/AuthView.vue') },
  {
    path: '/Character/Select',
    name: 'CharacterSelect',
    component: () => import('@/Views/Character/SelectorView.vue'),
  },
  {
    path: '/Character/Details',
    name: 'CharacterDetails',
    component: () => import('@/Views/Character/DetailsView.vue'),
  },
  {
    path: '/Character/Creator',
    name: 'CharacterCreator',
    component: () => import('@/Views/Character/CreatorView.vue'),
  },
  // Spawn handed off to the Frontend; SPA renders nothing while the player
  // is in-world. Re-uses HiddenView so a single mount point handles every
  // "invisible" SPA state.
  { path: '/InWorld', name: 'InWorld', component: () => import('@/Views/HiddenView.vue') },
];

export const Router = createRouter({
  history: createMemoryHistory(),
  routes: Routes,
});
