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
  banner: {
    js: `// reflect-metadata is bundled inline below.`,
  },
};

if (Watch) {
  const Ctx = await esbuild.context(Config);
  await Ctx.watch();
  console.log('[Frontend] esbuild watching');
} else {
  await esbuild.build(Config);
  console.log('[Frontend] bundle written to', Config.outfile);
}
