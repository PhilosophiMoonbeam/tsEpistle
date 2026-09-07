import type { SystemSummary } from './system-api'

export type AdminNavItem = {
  key: string
  label: string
  icon: string
  to?: string
  href?: string
  permission?: string | string[]
  count?: number
  enabled?: boolean
  description?: string
  keywords?: string
}

export type AdminNavGroup = {
  key: string
  label: string
  icon: string
  description: string
  items: AdminNavItem[]
}

export function buildAdminNavigation(translate: (key: string) => string, permissions: string[], info: SystemSummary): AdminNavGroup[] {
  const hasPermission = (permission: string | string[]) =>
    Array.isArray(permission) ? permission.some(value => permissions.includes(value)) : permissions.includes(permission)
  const groups: AdminNavGroup[] = [
    {
      key: 'knowledge',
      label: 'Knowledge',
      icon: 'mdi-book-open-page-variant-outline',
      description: 'Organize what your wiki knows.',
      items: [
        {
          key: 'pages',
          label: translate('admin:pages.title'),
          icon: 'mdi-file-document-multiple-outline',
          to: '/pages',
          permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages'],
          count: info.pagesTotal,
          description: 'Pages, ownership and publication',
          keywords: ''
        },
        {
          key: 'tags',
          label: translate('admin:tags.title'),
          icon: 'mdi-tag-multiple-outline',
          to: '/tags',
          permission: 'manage:system',
          count: info.tagsTotal,
          description: 'Topics and content organization',
          keywords: ''
        },
        {
          key: 'editor',
          label: 'Editors',
          icon: 'mdi-pencil-ruler',
          to: '/editor',
          permission: 'manage:system',
          description: 'Writing tools and defaults',
          keywords: ''
        },
        {
          key: 'rendering',
          label: translate('admin:rendering.title'),
          icon: 'mdi-text-box-edit-outline',
          to: '/rendering',
          permission: 'manage:system',
          description: 'Content processing and display',
          keywords: ''
        },
        {
          key: 'comments',
          label: translate('admin:comments.title'),
          icon: 'mdi-comment-text-multiple-outline',
          to: '/comments',
          permission: 'manage:system',
          description: 'Discussion on wiki pages',
          keywords: ''
        }
      ]
    },
    {
      key: 'people',
      label: 'People & access',
      icon: 'mdi-account-multiple-outline',
      description: 'Manage membership and permissions.',
      items: [
        {
          key: 'users',
          label: translate('admin:users.title'),
          icon: 'mdi-account-outline',
          to: '/users',
          permission: ['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users'],
          count: info.usersTotal,
          description: 'Accounts and member access',
          keywords: 'members invite accounts'
        },
        {
          key: 'groups',
          label: translate('admin:groups.title'),
          icon: 'mdi-account-group-outline',
          to: '/groups',
          permission: ['manage:system', 'manage:groups', 'write:groups'],
          count: info.groupsTotal,
          description: 'Roles and permission rules',
          keywords: ''
        },
        {
          key: 'auth',
          label: translate('admin:auth.title'),
          icon: 'mdi-shield-account-outline',
          to: '/auth',
          permission: 'manage:system',
          description: 'Sign-in methods and identity providers',
          keywords: 'SSO login authentication identity'
        },
        {
          key: 'security',
          label: translate('admin:security.title'),
          icon: 'mdi-shield-lock-outline',
          to: '/security',
          permission: 'manage:system',
          description: 'Sessions and access protection',
          keywords: ''
        }
      ]
    },
    {
      key: 'intelligence',
      label: 'Intelligence & connections',
      icon: 'mdi-creation-outline',
      description: 'Connect knowledge to people and agents.',
      items: [
        {
          key: 'search',
          label: translate('admin:search.title'),
          icon: 'mdi-text-search-variant',
          to: '/search',
          permission: 'manage:system',
          description: 'Search engines and index maintenance',
          keywords: 'discovery index retrieval'
        },
        {
          key: 'agents',
          label: translate('admin:agents.title'),
          icon: 'mdi-robot-outline',
          to: '/agents',
          permission: 'manage:system',
          description: 'Wiki Agent, providers, skills and MCP',
          keywords: 'AI memory model provider skills MCP tools'
        },
        {
          key: 'api',
          label: translate('admin:api.title'),
          icon: 'mdi-api',
          to: '/api',
          permission: ['manage:system', 'manage:api'],
          description: 'API keys and integration reference',
          keywords: 'REST GraphQL tokens integrations MCP'
        },
        {
          key: 'webhooks',
          label: 'Webhooks',
          icon: 'mdi-webhook',
          to: '/webhooks',
          permission: 'manage:system',
          description: 'Event delivery to external services',
          keywords: ''
        }
      ]
    },
    {
      key: 'workspace',
      label: 'Workspace',
      icon: 'mdi-tune-variant',
      description: 'Shape the reading and writing experience.',
      items: [
        {
          key: 'general',
          label: translate('admin:general.title'),
          icon: 'mdi-tune-variant',
          to: '/general',
          permission: 'manage:system',
          description: 'Site identity, logo and behavior',
          keywords: 'branding title logo URL'
        },
        {
          key: 'theme',
          label: translate('admin:theme.title'),
          icon: 'mdi-palette-outline',
          to: '/theme',
          permission: ['manage:system', 'manage:theme'],
          description: 'Colors, typography and presentation',
          keywords: 'appearance font dark light palette'
        },
        {
          key: 'navigation',
          label: translate('admin:navigation.title'),
          icon: 'mdi-navigation-variant-outline',
          to: '/navigation',
          permission: ['manage:system', 'manage:navigation'],
          description: 'Sidebar structure and links',
          keywords: ''
        },
        {
          key: 'locale',
          label: translate('admin:locale.title'),
          icon: 'mdi-translate',
          to: '/locale',
          permission: 'manage:system',
          description: 'Languages and translations',
          keywords: ''
        },
        {
          key: 'analytics',
          label: translate('admin:analytics.title'),
          icon: 'mdi-chart-areaspline',
          to: '/analytics',
          permission: 'manage:system',
          description: 'Audience and usage tracking',
          keywords: ''
        }
      ]
    },
    {
      key: 'operations',
      label: 'Operations',
      icon: 'mdi-server-outline',
      description: 'Maintain the systems behind your wiki.',
      items: [
        {
          key: 'system',
          label: 'System',
          icon: 'mdi-monitor-dashboard',
          to: '/system',
          permission: 'manage:system',
          description: 'Runtime observations, background work and support reports',
          keywords: 'health diagnostics scheduler queue migrations deployment'
        },
        {
          key: 'storage',
          label: translate('admin:storage.title'),
          icon: 'mdi-database-outline',
          to: '/storage',
          permission: 'manage:system',
          description: 'Content synchronization and backups',
          keywords: 'backup sync git export'
        },
        {
          key: 'mail',
          label: translate('admin:mail.title'),
          icon: 'mdi-email-outline',
          to: '/mail',
          permission: 'manage:system',
          description: 'Outgoing email delivery',
          keywords: ''
        },
        {
          key: 'ssl',
          label: 'HTTPS & certificates',
          icon: 'mdi-certificate-outline',
          to: '/ssl',
          permission: 'manage:system',
          description: 'Certificates and HTTPS',
          keywords: ''
        },
        {
          key: 'logging',
          label: 'Logging',
          icon: 'mdi-text-box-search-outline',
          to: '/logging',
          permission: 'manage:system',
          description: 'Log destinations and diagnostics',
          keywords: ''
        },
        {
          key: 'extensions',
          label: translate('admin:extensions.title'),
          icon: 'mdi-puzzle-plus-outline',
          to: '/extensions',
          permission: 'manage:system',
          description: 'Installed platform extensions',
          keywords: ''
        },
        {
          key: 'utilities',
          label: translate('admin:utilities.title'),
          icon: 'mdi-toolbox-outline',
          to: '/utilities',
          permission: 'manage:system',
          description: 'Export, import and maintenance tools',
          keywords: ''
        },
        {
          key: 'dev-flags',
          label: translate('admin:dev.flags.title'),
          icon: 'mdi-toggle-switch-off-outline',
          to: '/dev-flags',
          permission: ['manage:system', 'manage:api'],
          description: 'Advanced deployment feature flags',
          keywords: ''
        },
        {
          key: 'graphql',
          label: 'GraphQL explorer',
          icon: 'mdi-graphql',
          href: '/graphql',
          permission: ['manage:system', 'manage:api'],
          description: 'Explore the GraphQL schema',
          keywords: ''
        }
      ]
    }
  ]
  return groups
    .map(group => ({ ...group, items: group.items.filter(item => item.enabled !== false && (!item.permission || hasPermission(item.permission))) }))
    .filter(group => group.items.length > 0)
}

export function filterAdminNavigation(groups: AdminNavGroup[], search: string): AdminNavGroup[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return groups
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item =>
        terms.every(term => `${group.label} ${item.label} ${item.description || ''} ${item.keywords || ''}`.toLocaleLowerCase().includes(term))
      )
    }))
    .filter(group => group.items.length > 0)
}
