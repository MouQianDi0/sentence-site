// ESLint：JS 推荐规则 + typescript-eslint 推荐规则；格式交给 Prettier，这里不管
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'backups/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['api/**/*.ts', 'shared/**/*.ts', '*.js', 'web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // 下划线开头的参数、变量是故意不用的
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 空的 catch 里要写一句注释说明为什么忽略
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },
  {
    // 测试里读接口返回的 JSON 时直接用 any 更省事
    files: ['api/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
