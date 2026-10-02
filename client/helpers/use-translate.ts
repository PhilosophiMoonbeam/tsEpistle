import { getCurrentInstance } from 'vue'
import { translate } from '../modules/localization.ts'

export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The component's `$t` for `<script setup>` code. Call it during setup.
 * Outside a component it falls back to the app localization.
 */
export const useTranslate = (): Translate => getCurrentInstance()?.appContext.config.globalProperties.$t ?? translate
