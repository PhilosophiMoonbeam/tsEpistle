export type GroupRuleMatch = 'START' | 'END' | 'REGEX' | 'TAG' | 'EXACT'
export interface GroupPageRule {
  id: string
  match: GroupRuleMatch
  path: string
  deny: boolean
  roles: string[]
  locales: string[]
}
export interface GroupPolicyDraft {
  name: string
  description: string
  redirectOnLogin: string
  permissions: string[]
  pageRules: GroupPageRule[]
}
export interface GroupPermission {
  key: string
  title: string
  description: string
  category: string
  pageScoped: boolean
  tier: 'content' | 'administrative' | 'system'
}
const content = (key: string, title: string, description: string): GroupPermission => ({
  key,
  title,
  description,
  category: 'Knowledge',
  pageScoped: true,
  tier: key === 'write:scripts' ? 'system' : 'content'
})
const global = (key: string, title: string, description: string, category: string, tier: GroupPermission['tier'] = 'administrative'): GroupPermission => ({
  key,
  title,
  description,
  category,
  pageScoped: false,
  tier
})
export const groupPermissions: GroupPermission[] = [
  content('read:pages', 'Read pages', 'View public pages allowed by page rules.'),
  content('write:pages', 'Create and edit pages', 'Create and edit public pages allowed by page rules.'),
  content('manage:pages', 'Move pages', 'Rename or move public pages allowed by page rules.'),
  content('delete:pages', 'Delete pages', 'Delete public pages allowed by page rules.'),
  content('read:source', 'View source', 'Read the source of allowed pages.'),
  content('read:history', 'View history', 'Read the history of allowed pages.'),
  content('write:styles', 'Add page styles', 'Insert CSS into allowed pages.'),
  content('write:scripts', 'Run page scripts', 'Insert JavaScript into pages. Scripts can affect other readers.'),
  content('read:assets', 'Use assets', 'View and use assets within allowed paths.'),
  content('write:assets', 'Upload assets', 'Upload files within allowed paths.'),
  content('manage:assets', 'Manage assets', 'Edit and delete files within allowed paths.'),
  content('read:comments', 'Read discussions', 'Read comments on allowed pages.'),
  content('write:comments', 'Join discussions', 'Post comments on allowed pages.'),
  content('manage:comments', 'Moderate discussions', 'Moderate comments on allowed pages; administration may require additional authority.'),
  global('use:agents', 'Use the Wiki Agent', 'Start private agent sessions. Tools retain their own permission checks.', 'Intelligence', 'content'),
  global('use:agent-browser', 'Use agent browsing', 'Use enabled browser actions. Also requires Use the Wiki Agent.', 'Intelligence', 'content'),
  global('use:mcp', 'Connect through MCP', 'Use /mcp through eligible API keys for this group.', 'Intelligence', 'content'),
  global('write:users', 'Create accounts', 'Create accounts and assign groups within your administrative scope.', 'People & access'),
  global('manage:users', 'Manage accounts', 'Manage account lifecycles within your administrative scope.', 'People & access'),
  global('write:groups', 'Manage content groups', 'Manage groups without administrative or system authority.', 'People & access'),
  global('manage:groups', 'Manage administrative groups', 'Manage groups and permissions except system authority and page scripts.', 'People & access'),
  global('manage:navigation', 'Manage navigation', 'Edit workspace navigation.', 'Workspace'),
  global('manage:theme', 'Manage appearance', 'Change declarative workspace appearance. Custom CSS and HTML require full system administration.', 'Workspace'),
  global('manage:api', 'Manage API credentials', 'Issue and revoke credentials within the API permission policy.', 'Workspace'),
  global(
    'manage:system',
    'Full system administration',
    'Access all administration and content, including private pages. Bypasses page rules.',
    'Workspace',
    'system'
  )
]
export interface GroupMember {
  id: number
  name: string
  email: string
  isActive: boolean
  canRemove: boolean
}
export interface GroupEvent {
  id: number
  action: string
  reason: string
  actorId: number | null
  details: Record<string, unknown>
  createdAt: string
}
export interface GroupRecord extends GroupPolicyDraft {
  id: number
  isSystem: boolean
  memberCount: number
  apiKeyCount: number
  updatedAt: string
}
export interface GroupWorkspace extends GroupRecord {
  fingerprint: string
  capabilities: { edit: boolean; members: boolean; delete: boolean; rename: boolean; permissions: boolean; explanation: string }
  dependencies: { authentication: number; navigation: number; agentProviders: number; agentSkills: number }
  allowedPermissions: string[]
  history: GroupEvent[]
}
export type GroupSummary = Omit<GroupRecord, 'pageRules' | 'redirectOnLogin'> & { ruleCount: number }
export interface GroupDirectory {
  items: GroupSummary[]
  total: number
  limit: number
  offset: number
  counts: { groups: number; system: number; empty: number; administrative: number }
  canCreate: boolean
}
export interface GroupMembers {
  items: GroupMember[]
  total: number
  limit: number
  offset: number
}
export interface GroupWriteResult {
  id: number
  sessionsEnded: number
  currentSessionEnded: boolean
}
export interface GroupAccessInput {
  path: string
  locale: string
  tags: string[]
  permission: string
  memberId?: number
  draft?: GroupPolicyDraft
}
export interface GroupAccessResult {
  allowed: boolean
  reason: string
  scope: 'group' | 'member'
  source: 'saved' | 'draft'
  subject: string
  globalPermissions: string[]
  ruleCount: number
  rulesTruncated: boolean
  rules: Array<{
    groupId: number
    groupName: string
    ruleId: string
    match: GroupRuleMatch
    path: string
    deny: boolean
    outcome: 'winner' | 'overridden' | 'no-match' | 'locale' | 'permission'
  }>
  fingerprint: string
}
