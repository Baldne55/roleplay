/**
 * Ambient type declarations for the UI bundle.
 *
 * Pulls in Vite's client types (import.meta.env, asset imports) and
 * declares the `*.vue` module shim below.
 */
/// <reference types="vite/client" />

// SFC module shim so plain @typescript-eslint (which cannot parse .vue
// imports) types them as components. vue-tsc resolves real SFC files
// natively, so this fallback never shadows the precise types.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const Component: DefineComponent;
  export default Component;
}
