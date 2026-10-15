import { z } from 'zod'
import { navigationDestination, type NavigationPolicy } from './navigation-policy.ts'
import { hasAsciiControlCharacters } from './text-safety.ts'
import { parsePrivatePagePath } from './private-page-route.ts'

const IdentitySchema = z.strictObject({ locale: z.string().min(2).max(35), path: z.string().min(1).max(2048) })
export const NavigationRepairItemSchema = z.strictObject({
  locale: z.string().min(2).max(35),
  itemId: z.string().min(1).max(100),
  oldTarget: z.string().min(1).max(2048),
  newTarget: z.string().min(1).max(2048)
})
export const NavigationMoveReviewSchema = z.strictObject({
  pageId: z.number().int().positive().safe(),
  menuLocale: z.string().min(2).max(35),
  sourceRevision: z.string().regex(/^[1-9][0-9]*$/),
  historyId: z.number().int().positive().safe(),
  oldIdentity: IdentitySchema,
  newIdentity: IdentitySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().safe(),
  items: z.array(NavigationRepairItemSchema).max(200),
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/)
})
export type NavigationMoveReview = z.infer<typeof NavigationMoveReviewSchema>
export type NavigationRepairItem = z.infer<typeof NavigationRepairItemSchema>
export const navigationRepairItemKey = (item: { locale: string; itemId: string }): string => JSON.stringify([item.locale, item.itemId])

/** Decode only strict, explicit locale-qualified targets before using native private-route interpretation. */
const parseNavigationPublicTarget = (target: string): { locale: string; path: string; suffix: string } | null => {
  if (!navigationDestination('page', target)) return null
  const boundary = target.search(/[?#]/),
    pathname = boundary < 0 ? target : target.slice(0, boundary),
    suffix = boundary < 0 ? '' : target.slice(boundary)
  try {
    const segments = pathname
      .slice(1)
      .split('/')
      .map(segment => decodeURIComponent(segment))
    const locale = segments[0]
    if (
      !locale ||
      segments.length < 2 ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/]/.test(segment) || hasAsciiControlCharacters(segment))
    )
      return null
    const path = segments.slice(1).join('/')
    if (parsePrivatePagePath(segments.join('/')) || parsePrivatePagePath(path)) return null
    return { locale, path, suffix }
  } catch {
    return null
  }
}

/** Only explicit, segment-wise locale-qualified public routes are unambiguous here. */
export const movedNavigationTarget = (
  target: string,
  oldIdentity: { locale: string; path: string },
  newIdentity: { locale: string; path: string }
): string | null => {
  const source = parseNavigationPublicTarget(target)
  if (!source || source.locale !== oldIdentity.locale || source.path !== oldIdentity.path) return null
  try {
    const result = '/' + [newIdentity.locale, ...newIdentity.path.split('/')].map(encodeURIComponent).join('/') + source.suffix
    const destination = parseNavigationPublicTarget(result)
    return destination && destination.locale === newIdentity.locale && destination.path === newIdentity.path && result !== target ? result : null
  } catch {
    return null
  }
}
export const movedNavigationItems = (
  policy: NavigationPolicy,
  menuLocale: string,
  oldIdentity: { locale: string; path: string },
  newIdentity: { locale: string; path: string }
): NavigationRepairItem[] => {
  const items: NavigationRepairItem[] = []
  for (const item of policy.tree.find(tree => tree.locale === menuLocale)?.items ?? []) {
    if (item.kind !== 'link' || item.targetType !== 'page') continue
    const newTarget = movedNavigationTarget(item.target, oldIdentity, newIdentity)
    if (newTarget) items.push({ locale: menuLocale, itemId: item.id, oldTarget: item.target, newTarget })
  }
  return items
}
export const applyNavigationMoveRepair = (policy: NavigationPolicy, items: readonly NavigationRepairItem[]): NavigationPolicy => {
  const replacements = new Map(items.map(item => [navigationRepairItemKey(item), item]))
  return {
    ...policy,
    tree: policy.tree.map(tree => ({
      ...tree,
      items: tree.items.map(item => {
        const repair = replacements.get(navigationRepairItemKey({ locale: tree.locale, itemId: item.id }))
        return repair &&
          item.kind === 'link' &&
          item.targetType === 'page' &&
          item.target === repair.oldTarget &&
          parseNavigationPublicTarget(repair.oldTarget) &&
          parseNavigationPublicTarget(repair.newTarget)
          ? { ...item, target: repair.newTarget }
          : item
      })
    }))
  }
}
