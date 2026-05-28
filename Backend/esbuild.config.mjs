/**
 * Backend bundle config. Single-file output consumed by FXServer as a
 * `server_script` from fxmanifest.lua. Bundles all deps inline (FXServer's
 * Node runtime has no npm context to resolve from at load time).
 */
import esbuild from 'esbuild';

const Watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const Config = {
  entryPoints: ['Src/Index.ts'],
  outfile: '../Production/Windows/resources/[local]/roleplay/Dist/Backend.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  external: [
    // FXServer's Node runtime exposes these as globals.
    'citizen-server-impl',
    // Sequelize's optional dialect drivers - we use mysql2, the rest are
    // dynamic-require'd inside Sequelize and esbuild can't tree-shake
    // them out. Marking external lets esbuild leave the require() in
    // place; Sequelize only calls them if you pick that dialect.
    'pg-hstore',
    'pg',
    'tedious',
    'sqlite3',
    'mariadb',
    'oracledb',
    'snowflake-sdk',
    'ibm_db',
    'odbc',
  ],
  // reflect-metadata intentionally NOT loaded: it monkey-patches the global
  // Reflect object in ways that have historically interacted badly with
  // FXServer's mono-V8 boundary. We don't use tsyringe's constructor-param
  // metadata anywhere (every service either has an empty constructor or
  // resolves dependencies manually), so going without it is fine.
};

if (Watch) {
  const Ctx = await esbuild.context(Config);
  await Ctx.watch();
  console.log('[Backend] esbuild watching');
} else {
  await esbuild.build(Config);
  console.log('[Backend] bundle written to', Config.outfile);
}
