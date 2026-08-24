import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vuetify from 'eslint-plugin-vuetify'

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

const crossBoundaryImportRules = {
  client: ['**/server/**', 'server/**'],
  server: ['**/client/**', 'client/**'],
  shared: ['**/client/**', '**/server/**', 'client/**', 'server/**']
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
        templateTokenizer: {
          pug: 'vue-eslint-parser-template-tokenizer-pug'
        }
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        WIKI: 'readonly',
        siteLangs: 'readonly',
        siteConfig: 'readonly'
      }
    },
    plugins: {
      vuetify
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/valid-v-slot': ['error', { allowModifiers: true }],
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
      }],
      'vuetify/grid-unknown-attributes': 'error',
      'vuetify/no-deprecated-classes': 'error',
      'vuetify/no-deprecated-colors': 'error',
      'vuetify/no-deprecated-components': 'error',
      'vuetify/no-deprecated-imports': 'error',
      'vuetify/no-deprecated-events': 'error',
      'vuetify/no-deprecated-props': 'error',
      'vuetify/no-deprecated-slots': 'error',
      'vuetify/no-deprecated-snackbar': 'error',
      'vuetify/no-deprecated-typography': 'error',
      'vuetify/no-elevation-overflow': 'error',
      'vuetify/no-legacy-grid-props': 'error'
    }
  },
  {
    files: ['client/**/*.{js,ts,vue}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: crossBoundaryImportRules.client,
          message: 'Client code may import only client, shared, and third-party modules.'
        }]
      }]
    }
  },
  {
    files: ['client/**/*.test.{js,ts}'],
    rules: {
      'no-restricted-imports': 'off'
    }
  },
  {
    files: ['server/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: crossBoundaryImportRules.server,
          message: 'Server code may import only server, shared, and third-party modules.'
        }]
      }]
    }
  },
  {
    files: ['shared/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: crossBoundaryImportRules.shared,
          message: 'Shared contracts must not depend on client or server implementations.'
        }]
      }]
    }
  },
  {
    files: ['server/controllers/**/*.{js,ts}', 'server/graph/**/*.{js,ts}', 'server/core/servers.ts', 'server/master.ts'],
    rules: {
      'no-restricted-globals': ['error', {
        name: 'WIKI',
        message: 'Transport code must receive runtime dependencies from its composition root.'
      }],
      'no-restricted-properties': ['error', {
        object: 'globalThis',
        property: 'WIKI',
        message: 'Transport code must receive runtime dependencies from its composition root.'
      }]
    }
  },
  {
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  }
)
