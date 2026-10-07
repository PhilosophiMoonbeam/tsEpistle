import { getCurrentInstance } from 'vue'
import { translate } from '../modules/localization.ts'

export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The component's `$t` for `<script setup>` code. Call it during setup.
 * Outside a component it falls back to the app localization.
 * A qualified key prefix scopes local keys; explicit namespace keys remain unchanged.
 */
export const useTranslate = (keyPrefix = ''): Translate => {
  const translator: Translate = getCurrentInstance()?.appContext.config.globalProperties.$t ?? translate
  if (!keyPrefix) return translator
  const prefix = `${keyPrefix}.`
  return (key, options) => translator(key.includes(':') ? key : prefix + key, options)
}
