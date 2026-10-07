/**
 * ESLint flat config（工程规范 §3，T0-06 落地）
 * - 全仓 ts/tsx 走 typescript-eslint recommended（非 type-aware，无需 projectService）
 * - apps/web 额外启用 eslint-plugin-react-hooks recommended（含 compiler 系规则）
 * - 构建产物、依赖、覆盖率目录与本机工具目录（.zcode/.mimosa，均已在 .gitignore）一律忽略
 * 根 package.json 未声明 "type"：本文件按 CommonJS 加载
 */
const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')

module.exports = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.zcode/**',
      '.mimosa/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  {
    // 根目录无 "type": "module"，本文件必须以 CommonJS 书写，require 是既定选择而非违规
    files: ['eslint.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
