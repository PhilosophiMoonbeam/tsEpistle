export type AccountAction = 'activate' | 'deactivate' | 'verify' | 'require-2fa' | 'reset-2fa' | 'disable-2fa' | 'end-sessions'
export interface AccountProvider {
  key: string
  title: string
  strategy: string
  enabled: boolean
  available: boolean
  localPassword: boolean
  supportsTwoFactor: boolean
}
export interface AccountGroup {
  id: number
  name: string
  permissions: string[]
  canAssign: boolean
  isSystem: boolean
}
export interface AccountCreationOptions {
  providers: AccountProvider[]
  groups: AccountGroup[]
  fingerprint: string
}
export interface AccountRecord {
  id: number
  name: string
  email: string
  providerKey: string
  providerTitle: string
  isSystem: boolean
  isActive: boolean
  isVerified: boolean
  twoFactor: 'enrolled' | 'enrollment-required' | 'off' | 'provider-managed'
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  groups: Array<{ id: number; name: string }>
}
export interface AccountDirectory {
  items: AccountRecord[]
  total: number
  limit: number
  offset: number
  counts: { accounts: number; active: number; inactive: number; unverified: number }
  providers: AccountProvider[]
  groups: Array<{ id: number; name: string }>
  canCreate: boolean
}
export interface AccountEvent {
  id: number
  action: string
  reason: string
  details: Record<string, unknown>
  actorId: number | null
  createdAt: string
}
export interface AccountProfileDraft {
  name: string
  email: string
  location: string
  jobTitle: string
  pronouns: string
  timezone: string
  groups: number[]
}
export interface AccountWorkspace extends AccountRecord {
  profile: AccountProfileDraft
  provider: AccountProvider | null
  fingerprint: string
  availableGroups: AccountGroup[]
  permissions: string[]
  mustChangePassword: boolean
  sessionsRevokedAt: string | null
  privateOwnershipBlocksDeletion: boolean
  contributionCounts: { pagesCreated: number; pagesAuthored: number; comments: number; assets: number }
  capabilities: { edit: boolean; password: boolean; delete: boolean; actions: AccountAction[]; explanation: string }
  history: AccountEvent[]
}
export const accountActionTitle: Record<AccountAction, string> = {
  activate: 'Activate account',
  deactivate: 'Deactivate account',
  verify: 'Verify email address',
  'require-2fa': 'Require authenticator enrollment',
  'reset-2fa': 'Reset authenticator',
  'disable-2fa': 'Disable account two-factor requirement',
  'end-sessions': 'End sign-in sessions'
}
export const accountProfileIssues = (profile: AccountProfileDraft): string[] => {
  const issues: string[] = []
  if (profile.name.trim().length < 2 || profile.name.trim().length > 255) issues.push('Display name must contain 2–255 characters.')
  if (profile.email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) issues.push('Enter a valid email address.')
  if (profile.location.length > 255 || profile.jobTitle.length > 255) issues.push('Location and job title must be at most 255 characters.')
  if (profile.pronouns.length > 255) issues.push('Pronouns must be at most 255 characters.')
  try {
    if (!profile.timezone || profile.timezone.length > 100) throw new Error()
    new Intl.DateTimeFormat('en', { timeZone: profile.timezone })
  } catch {
    issues.push('Choose a valid time zone.')
  }
  if (
    profile.groups.length > 500 ||
    new Set(profile.groups).size !== profile.groups.length ||
    profile.groups.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
  )
    issues.push('Choose valid, unique groups.')
  return issues
}
