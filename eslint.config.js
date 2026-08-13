import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

const testGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  it: 'readonly',
  test: 'readonly',
  vi: 'readonly'
}

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/*.min.js',
    'assets/**',
    'client/libs/**',
    'coverage/**',
    'data/**',
    'logs/**',
    'repo/**',
    'test-results/**'
  ]),
  {
    files: ['**/*.{js,mjs}'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...testGlobals,
        WIKI: 'readonly',
        wiki: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...testGlobals,
        WIKI: 'readonly',
        wiki: 'readonly'
      }
    }
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        WIKI: 'readonly',
        siteLangs: 'readonly',
        siteConfig: 'readonly'
      }
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/custom-event-name-casing': ['error', 'camelCase', {
        ignores: [
          'searchEnter',
          'searchMove',
          'saveConflict',
          'resetEditorConflict',
          'overwriteEditorContent',
          'editorInsert',
          'pageEdit',
          'pageHistory',
          'pageSource',
          'pageConvert',
          'pageDuplicate',
          'pageMove',
          'pageDelete'
        ]
      }]
    }
  },
  {
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  }
)
