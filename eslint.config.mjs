/**
 * Strict TypeScript rules. The two non-negotiables:
 *   - no `any` anywhere (`no-explicit-any` + `no-unsafe-*`)
 *   - PascalCase identifiers with all-caps acronyms (Java-legacy style)
 *
 * Wire-event strings stay PascalCase (e.g. 'Roleplay:Net:Auth:RequestState')
 * — see Shared/Events/*. Engine event names (`playerConnecting`) are the only
 * lowercase exception and live as string literals at the call site.
 *
 * This is the LIVE configuration. ESLint 9 resolves flat config by default,
 * so the legacy `.eslintrc.cjs` beside it is dead weight and is not loaded —
 * edit this file, not that one.
 *
 * Typed rules resolve each file's nearest tsconfig.json via the project
 * service, so a new workspace is picked up without touching this file.
 * Vue SFC script blocks are parsed as TypeScript but only run the non-typed
 * rule set — typed linting inside SFCs is not wired up.
 */
import Js from '@eslint/js';
import Globals from 'globals';
import TsPlugin from '@typescript-eslint/eslint-plugin';
import TsParser from '@typescript-eslint/parser';
import VuePlugin from 'eslint-plugin-vue';

const TsFiles = ['**/*.ts', '**/*.tsx'];
const VueFiles = ['**/*.vue'];

const ScopeTo = (Configs, Files) => Configs.map((Entry) => ({ ...Entry, files: Files }));

/** Rule maps only (parser/plugin setup stripped) — reusable inside SFC script blocks. */
const TsNonTypedRules = TsPlugin.configs['flat/recommended']
  .filter((Entry) => Entry.rules)
  .reduce((Merged, Entry) => ({ ...Merged, ...Entry.rules }), {});

const NamingConvention = [
  'error',
  // Default: PascalCase. ESLint can't enforce all-caps-acronyms automatically
  // (no regex hook for that), so `DiscordID` and `DiscordId` both pass here
  // and only review catches the latter. The convention is written up in the
  // Shared/Events/ file headers.
  { selector: 'default', format: ['PascalCase'], leadingUnderscore: 'allow' },
  { selector: 'variable', format: ['PascalCase'], leadingUnderscore: 'allow' },
  { selector: 'parameter', format: ['PascalCase'], leadingUnderscore: 'allow' },
  { selector: 'property', format: ['PascalCase'], leadingUnderscore: 'allow' },
  { selector: 'method', format: ['PascalCase'] },
  { selector: 'function', format: ['PascalCase'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'enumMember', format: ['PascalCase'] },
  { selector: 'typeProperty', format: ['PascalCase'] },
  // Object-literal keys are format-free (some external libs return camelCase
  // payloads that we destructure with the original name). Same for object-literal
  // methods conforming to external shapes (vue-router `component`, umzug `up`/`down`)
  // and destructured bindings, which keep the source object's casing.
  { selector: 'objectLiteralProperty', format: null },
  { selector: 'objectLiteralMethod', format: null },
  { selector: ['variable', 'parameter'], modifiers: ['destructured'], format: null },
  // Import names follow the source module's casing.
  { selector: 'import', format: null },
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/Production/**',
      '**/Dist/**',
      '**/Build/**',
      '**/build/**',
      '**/.vite/**',
    ],
  },

  // Baseline for every linted file (plain JS build scripts, LoadScreen, configs).
  Js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...Globals.node, ...Globals.browser },
    },
  },

  // TypeScript — full typed linting (recommended-type-checked + strict, as the
  // legacy .eslintrc extends chain did).
  ...ScopeTo(
    [
      ...TsPlugin.configs['flat/recommended-type-checked'],
      ...TsPlugin.configs['flat/strict'],
    ],
    TsFiles,
  ),
  {
    files: TsFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
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
      '@typescript-eslint/naming-convention': NamingConvention,
    },
  },

  // Vue SFCs — vue-eslint-parser with TS script blocks, vue/recommended rules,
  // plus the non-typed TypeScript rule set.
  ...ScopeTo(VuePlugin.configs['flat/recommended'], VueFiles),
  {
    files: VueFiles,
    plugins: { '@typescript-eslint': TsPlugin },
    languageOptions: {
      globals: { ...Globals.browser },
      parserOptions: {
        parser: TsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      ...TsNonTypedRules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/naming-convention': NamingConvention,
      // Templates use a compact style: multiple attributes per line, single-line
      // text elements. The strongly-recommended layout rules fight that — off.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-newline': 'off',
      // Props are PascalCase (project convention). Hyphenating attributes would
      // break the binding (Vue camelizes `my-prop` to `myProp`, not `MyProp`),
      // and `prop-name-casing` has no PascalCase option.
      'vue/attribute-hyphenation': 'off',
      'vue/prop-name-casing': 'off',
    },
  },
];
