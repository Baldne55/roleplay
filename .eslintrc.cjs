/**
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
    project: ['./tsconfig.base.json', './*/tsconfig.json', './UCP/*/tsconfig.json'],
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
      // Default: PascalCase. ESLint can't enforce all-caps-acronyms automatically
      // (no regex hook for that). Manual code-review catches it; convention is
      // documented in Shared/Events/ and CLAUDE.md.
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
