/**
 * SUPERSEDED - THIS FILE IS NOT LOADED.
 *
 * ESLint 9 resolves flat config by default, so `eslint.config.mjs` in this
 * same directory is what actually runs. Everything below is the legacy
 * eslintrc form kept only for reference; editing it changes nothing.
 * Rule changes belong in eslint.config.mjs.
 *
 * (Delete this file once nothing is pinned to the legacy resolver. It is
 * tracked in git while the live flat config currently is not, which is
 * exactly backwards.)
 *
 * Strict TypeScript rules. The two non-negotiables:
 *   - no `any` anywhere (`no-explicit-any` + `no-unsafe-*`)
 *   - PascalCase identifiers with all-caps acronyms (Java-legacy style)
 *
 * Wire-event strings stay PascalCase (e.g. 'Roleplay:Net:Auth:RequestState')
 * — see Shared/Events/*. Engine event names (`playerConnecting`) are the only
 * lowercase exception and live as string literals at the call site.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // One entry per workspace. The `./UCP/*/tsconfig.json` glob that used
    // to sit here was dropped: no UCP workspace exists, and a glob that
    // matches nothing is silently ignored, so it read as a supported
    // surface that was never actually linted.
    project: ['./tsconfig.base.json', './*/tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:@typescript-eslint/strict',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/strict-boolean-expressions': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
    '@typescript-eslint/naming-convention': [
      'error',
      // Default: PascalCase. ESLint can't enforce all-caps-acronyms
      // automatically (no regex hook for that), so `DiscordID` and
      // `DiscordId` both pass here and only review catches the latter.
      // The convention is written up in the Shared/Events/ file headers.
      { selector: 'default',          format: ['PascalCase'], leadingUnderscore: 'allow' },
      { selector: 'variable',         format: ['PascalCase'], leadingUnderscore: 'allow' },
      { selector: 'parameter',        format: ['PascalCase'], leadingUnderscore: 'allow' },
      { selector: 'property',         format: ['PascalCase'], leadingUnderscore: 'allow' },
      { selector: 'method',           format: ['PascalCase'] },
      { selector: 'function',         format: ['PascalCase'] },
      { selector: 'typeLike',         format: ['PascalCase'] },
      { selector: 'enumMember',       format: ['PascalCase'] },
      { selector: 'typeProperty',     format: ['PascalCase'] },
      // Object-literal keys are format-free (some external libs return camelCase
      // payloads that we destructure with the original name).
      { selector: 'objectLiteralProperty', format: null },
      // Import names follow the source module's casing.
      { selector: 'import', format: null },
    ],
  },
  ignorePatterns: [
    'node_modules',
    '**/Dist/**',
    '**/Production/**',
    '**/build/**',
    '**/.vite/**',
  ],
};
