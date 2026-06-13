import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat ESLint config. The repo previously had ZERO linting yet shipped 4 production
 * `eslint-disable` comments that suppressed nothing (IMPROVEMENT-PLAN 12.2) - those now do
 * their job. Kept intentionally lenient (most stylistic checks are warnings, not errors) so
 * CI gates on real problems without forcing a mass refactor of an already-disciplined codebase.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'build/**',
      'specs/**',
      '*.config.{js,cjs,mjs,ts}',
      'postcss.config.cjs',
      '**/*.tsbuildinfo'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'prefer-const': 'warn'
    }
  }
);
