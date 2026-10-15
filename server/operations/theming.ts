import { ThemePolicySchema, themeChangedFields, themePolicyFromConfiguration } from '../../shared/theme-policy.ts'
import { ThemeColorsSchema } from '../../shared/theme-colors.ts'
import { getThemeAdministrationStore } from './theme-administration.ts'
import type { PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'

const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const getConfig = () => {
  const policy = themePolicyFromConfiguration(WIKI.config as unknown as Record<string, unknown>)
  return { ...policy, colors: policy.palettes.find(palette => palette.id === policy.activePaletteId)!.colors }
}
// The compatibility API participates in the same transaction and current authority checks.
const updateConfig = async (input: unknown, requester?: PagePrincipal): Promise<void> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Theme configuration must be an object.')
  const patch = input as Record<string, unknown>
  const service = getThemeAdministrationStore(),
    saved = await service.inspect(requester)
  if (Object.keys(patch).some(key => key !== 'colors' && !Object.hasOwn(saved.policy, key))) return fail('Theme configuration contains unsupported fields.')
  const next: Record<string, unknown> = { ...saved.policy, ...patch }
  delete next.colors
  if (Object.hasOwn(patch, 'colors')) {
    const colors = ThemeColorsSchema.safeParse(patch.colors)
    if (!colors.success) return fail('Theme colors must be complete light and dark palettes of six-digit hex values.')
    if (!Object.hasOwn(patch, 'palettes'))
      next.palettes = saved.policy.palettes.map(palette => (palette.id === next.activePaletteId ? { ...palette, colors: colors.data } : palette))
  }
  const validation = ThemePolicySchema.safeParse(next)
  if (!validation.success) return fail('Theme configuration is invalid. Check the palette, icon library, layout, code appearance and custom code.')
  if (!themeChangedFields(saved.policy, validation.data).length) return
  const result = await service.save(requester, {
    policy: validation.data,
    fingerprint: saved.fingerprint,
    reason: 'Updated through the compatibility theme API'
  })
  if (result.activation === 'needs-attention')
    return fail('Theme settings were saved; runtime activation needs attention. Reload Theme before continuing.', 500)
}
export default { getConfig, updateConfig }
