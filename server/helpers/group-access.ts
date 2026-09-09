import type { GroupRuleMatch } from '../../shared/group-policy.ts'
import { isApiPrincipal } from './api-principal.ts'
import { resolveTagName } from './tag-aliases.ts'

export interface AccessRule {
  readonly id?: string
  readonly match: GroupRuleMatch
  readonly path: string
  readonly deny: boolean
  readonly roles: readonly string[]
  readonly locales?: readonly string[]
}

export interface AccessGroup {
  readonly id: number
  readonly name?: string
  readonly permissions?: readonly string[]
  readonly pageRules: readonly AccessRule[]
}

export interface AccessPage {
  readonly path: string
  readonly locale?: string
  readonly tags?: readonly { readonly tag: string }[]
}

export type PageRuleRequesterBinding =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'guest'; readonly userId: 2 }
  | { readonly kind: 'user'; readonly userId: number }
  | { readonly kind: 'apiKey'; readonly apiKeyId: number; readonly groupId: number }

export interface PageRuleAuthority {
  readonly requester: unknown
  readonly permissions: readonly string[]
  readonly groups: readonly AccessGroup[]
  readonly tagAliases: Readonly<Record<string, string | null>>
}

const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null

/**
 * Convert an authenticated principal to the stable identity used to select
 * groups. API principals intentionally select their assigned group because
 * they do not have a user-owned page namespace.
 */
export const pageRuleRequesterBinding = (requester: unknown): PageRuleRequesterBinding => {
  if (isApiPrincipal(requester)) return { kind: 'apiKey', apiKeyId: requester.api, groupId: requester.grp }
  if (typeof requester !== 'object' || requester === null) return { kind: 'anonymous' }
  const record = requester as Record<string, unknown>,
    id = positiveInteger(record.id),
    hasOwnership = Object.hasOwn(record, 'ownershipUserId'),
    ownership = record.ownershipUserId
  if (id === 2 && (!hasOwnership || ownership === null)) return { kind: 'guest', userId: 2 }
  if (id !== null && id !== 2 && (!hasOwnership || ownership === id)) return { kind: 'user', userId: id }
  return { kind: 'anonymous' }
}

export const pageRuleAuthorityMatchesRequester = (requester: unknown, authority: PageRuleAuthority): boolean =>
  Boolean(authority && typeof authority === 'object' && authority.requester === requester)

const rank: Record<GroupRuleMatch, number> = { START: 0, END: 1, REGEX: 2, TAG: 3, EXACT: 4 }

export interface RuleState {
  deny: boolean
  match: GroupRuleMatch | false
  specificity: string
}
export const applyPageRule = (rule: AccessRule, state: RuleState): RuleState => {
  if (rule.path.length < state.specificity.length) return state
  if (rule.path.length === state.specificity.length && state.match !== false) {
    if (rank[rule.match] < rank[state.match] || (rule.match === state.match && state.deny && !rule.deny)) return state
  }
  return { deny: rule.deny, match: rule.match, specificity: rule.path }
}
export const evaluateGroupAccess = (
  permissions: readonly string[],
  requested: readonly string[],
  groups: readonly AccessGroup[],
  page?: AccessPage | false,
  aliases: Readonly<Record<string, string | null>> = {},
  collectTrace = true
): {
  allowed: boolean
  reason: string
  rules: Array<{
    groupId: number
    groupName: string
    ruleId: string
    match: GroupRuleMatch
    path: string
    deny: boolean
    outcome: 'winner' | 'overridden' | 'no-match' | 'locale' | 'permission'
  }>
} => {
  const bypass = permissions.includes('manage:system'),
    hasPermission = requested.some(p => permissions.includes(p))
  let state: RuleState = { deny: false, match: false, specificity: '' }
  const trace: Array<{
    groupId: number
    groupName: string
    ruleId: string
    match: GroupRuleMatch
    path: string
    deny: boolean
    outcome: 'overridden' | 'no-match' | 'locale' | 'permission'
  }> = []
  if (page)
    for (const group of groups)
      for (const [index, rule] of group.pageRules.entries()) {
        let outcome: 'overridden' | 'no-match' | 'locale' | 'permission' = 'no-match',
          matches = false
        if (rule.locales?.length && (!page.locale || !rule.locales.includes(page.locale))) outcome = 'locale'
        else if (!rule.roles.some(role => requested.includes(role))) outcome = 'permission'
        else {
          if (rule.match === 'START') matches = `/${page.path}`.startsWith(`/${rule.path}`)
          if (rule.match === 'END') matches = page.path.endsWith(rule.path)
          if (rule.match === 'EXACT') matches = `/${page.path}` === `/${rule.path}`
          if (rule.match === 'REGEX') {
            try {
              matches = new RegExp(rule.path).test(page.path)
            } catch {
              matches = false
            }
          }
          if (rule.match === 'TAG') {
            const resolved = resolveTagName(aliases as Record<string, string | null>, rule.path)
            matches = resolved !== null && (page.tags ?? []).some(tag => resolveTagName(aliases as Record<string, string | null>, tag.tag) === resolved)
          }
          if (matches) {
            outcome = 'overridden'
            state = applyPageRule(rule, state)
          }
        }
        if (collectTrace)
          trace.push({
            groupId: group.id,
            groupName: group.name ?? `Group ${group.id}`,
            ruleId: rule.id ?? String(index + 1),
            match: rule.match,
            path: rule.path,
            deny: rule.deny,
            outcome
          })
      }
  const rules = trace.map(rule => ({
    ...rule,
    outcome:
      rule.outcome === 'overridden' && rule.path.length === state.specificity.length && rule.match === state.match && rule.deny === state.deny
        ? ('winner' as const)
        : rule.outcome
  }))
  return {
    allowed: bypass || (hasPermission && (!page || (state.match !== false && !state.deny))),
    reason: bypass
      ? 'Full system administration bypasses page rules.'
      : !hasPermission
        ? 'The required global permission is missing.'
        : !page
          ? 'The global permission is granted.'
          : state.match === false
            ? 'No page rule grants this action.'
            : state.deny
              ? 'The highest-priority matching rule denies this action.'
              : 'The highest-priority matching rule allows this action.',
    rules
  }
}
