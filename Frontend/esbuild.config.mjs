/**
 * Frontend bundle config. Single-file output consumed by FXServer as a
 * `client_script` from fxmanifest.lua. The client runs FiveM's V8 runtime
 * (browser-like, no Node APIs).
 */
import esbuild from 'esbuild';

const Watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const Config = {
  entryPoints: ['Src/Index.ts'],
  outfile: '../Production/Windows/resources/[local]/roleplay/Dist/Frontend.js',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  format: 'iife',
  sourcemap: 'inline',
  minify: false,
  logLevel: 'info',
  // `platform: 'neutral'` doesn't set mainFields by default. Explicit list
  // mirrors browser bundlers' resolution order so npm packages resolve.
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser'],
  // No banner. There used to be one asserting "reflect-metadata is bundled
  // inline below", which was false - reflect-metadata is imported nowhere,
  // is in no package.json, and no decorator-metadata DI is used on either
  // side (see the Backend config for why it was dropped). The banner was a
  // leftover from that abandoned approach and stamped the claim into every
  // built bundle, so it is gone rather than corrected.
};

if (Watch) {
  const Ctx = await esbuild.context(Config);
  await Ctx.watch();
  console.log('[Frontend] esbuild watching');
} else {
  await esbuild.build(Config);
  console.log('[Frontend] bundle written to', Config.outfile);
}
