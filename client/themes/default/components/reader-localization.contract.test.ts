import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from '../../../../server/test/bun-test.mts'

const root = process.cwd()
const catalog = JSON.parse(readFileSync(join(root, 'server/locales/en.json'), 'utf8')) as Record<string, unknown>
const templates = {
  page: readFileSync(join(root, 'client/themes/default/components/page.vue'), 'utf8'),
  sidebar: readFileSync(join(root, 'client/themes/default/components/nav-sidebar.vue'), 'utf8'),
  footer: readFileSync(join(root, 'client/themes/default/components/nav-footer.vue'), 'utf8'),
  tabset: readFileSync(join(root, 'client/themes/default/components/tabset.vue'), 'utf8')
}

const requiredKeys = [
  'common:header.breadcrumb',
  'common:sidebar.openNavigation',
  'common:sidebar.closeNavigation',
  'common:sidebar.noNavigationItems',
  'common:sidebar.loadingNavigation',
  'common:sidebar.navigationLoadError',
  'common:sidebar.noPagesInDirectory',
  'common:page.contentTabs',
  'common:page.noSections',
  'common:page.loadingPageNotifications',
  'common:page.pageNotificationsLoadError',
  'common:page.noPageNotifications',
  'common:page.loadingApprovalInbox',
  'common:page.approvalInboxLoadError',
  'common:page.noActiveApprovalRequests',
  'common:page.loadingPageProtection',
  'common:page.pageProtectionLoadError',
  'common:page.loadingApprovalWorkflow',
  'common:page.approvalWorkflowLoadError',
  'common:page.noContent',
  'common:page.tryAgain',
  'common:footer.sourceCode'
] as const

const requiredFragments = {
  page: [
    '$t(`common:sidebar.closeNavigation`)',
    '$t(`common:sidebar.openNavigation`)',
    ":aria-label='$t(`common:header.breadcrumb`)'",
    "{{$t('common:page.noSections')}}",
    ":title='$t(`common:page.loadingPageNotifications`)'",
    ":title='$t(`common:page.pageNotificationsLoadError`)'",
    ":title='$t(`common:page.noPageNotifications`)'",
    ":title='$t(`common:page.loadingApprovalInbox`)'",
    ":title='$t(`common:page.approvalInboxLoadError`)'",
    ":title='$t(`common:page.noActiveApprovalRequests`)'",
    ":title='$t(`common:page.loadingPageProtection`)'",
    ":title='$t(`common:page.pageProtectionLoadError`)'",
    ":title='$t(`common:page.loadingApprovalWorkflow`)'",
    ":title='$t(`common:page.approvalWorkflowLoadError`)'",
    ":title='$t(`common:page.noContent`)'",
    ":retry-label='$t(`common:page.tryAgain`)'"
  ],
  sidebar: [
    ":title='$t(`common:sidebar.noNavigationItems`)'",
    "{{$t('common:sidebar.loadingNavigation')}}",
    ":aria-label='$t(`common:sidebar.loadingNavigation`)'",
    ":title='$t(`common:sidebar.navigationLoadError`)'",
    ":title='$t(`common:sidebar.noPagesInDirectory`)'",
    ":retry-label='$t(`common:page.tryAgain`)'"
  ],
  footer: ["{{ $t('common:footer.sourceCode') }}"],
  tabset: [":aria-label='$t(`common:page.contentTabs`)'"]
} as const

const replacedLiterals = {
  page: [
    ":aria-label='navShown ? `Close navigation` : `Open navigation`'",
    "aria-label='Breadcrumb'",
    'span.text-body-small No sections on this page',
    "title='Loading page notifications'",
    "title='Page notifications could not be loaded'",
    "title='No page notifications'",
    "title='Loading approval inbox'",
    "title='Approval inbox could not be loaded'",
    "title='No active approval requests'",
    "title='Loading page protection'",
    "title='Page protection could not be loaded'",
    "title='Loading approval workflow'",
    "title='Approval workflow could not be loaded'",
    "title='This page has no content'",
    "retry-label='Try again'"
  ],
  sidebar: [
    "title='No navigation items'",
    ') Loading navigation',
    "aria-label='Loading navigation'",
    "title='Navigation could not be loaded'",
    "title='No pages in this directory'",
    "retry-label='Try again'"
  ],
  footer: [') Source Code'],
  tabset: ["aria-label='Content tabs'"]
} as const

function fallbackFor(key: string): unknown {
  let value: unknown = catalog
  for (const segment of key.replace(':', '.').split('.')) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

describe('reader shell localization contract', () => {
  test('keeps non-empty English fallbacks for semantic reader keys', () => {
    for (const key of requiredKeys) {
      const fallback = fallbackFor(key)
      expect(typeof fallback).toBe('string')
      expect((fallback as string).trim().length).toBeGreaterThan(0)
    }
  })

  test('uses semantic translations in each reader template', () => {
    for (const [component, fragments] of Object.entries(requiredFragments)) {
      for (const fragment of fragments) {
        expect(templates[component as keyof typeof templates]).toContain(fragment)
      }
    }
  })

  test('rejects the audited hard-coded reader controls and states', () => {
    for (const [component, literals] of Object.entries(replacedLiterals)) {
      for (const literal of literals) {
        expect(templates[component as keyof typeof templates]).not.toContain(literal)
      }
    }
  })
})
