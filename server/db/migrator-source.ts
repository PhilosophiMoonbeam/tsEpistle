import { createRequire } from 'node:module'
import path from 'node:path'

import fs from 'fs-extra'
import type { Knex } from 'knex'
import { migrationLedgerName, orderMigrationFiles } from './migration-contract.ts'

interface WikiDatabaseContext {
  SERVERPATH: string
}

interface MigrationSpec {
  file: string
}

export const KNOWN_APPLICATION_TABLES: Readonly<Record<string, true>> = {
  analytics: true,
  assets: true,
  assetData: true,
  assetFolders: true,
  authentication: true,
  comments: true,
  editors: true,
  groups: true,
  locales: true,
  loggers: true,
  navigation: true,
  pageHistory: true,
  pageLinks: true,
  pages: true,
  pageTree: true,
  renderers: true,
  searchEngines: true,
  settings: true,
  storage: true,
  tags: true,
  userKeys: true,
  users: true,
  pageHistoryTags: true,
  pageTags: true,
  userGroups: true,
  apiKeys: true,
  commentProviders: true,
  userAvatars: true,
  durableJobs: true,
  webhooks: true,
  outboxEvents: true,
  webhookDeliveries: true,
  pageWatchers: true,
  pageWatchNotifications: true,
  pageWatchDeliveries: true,
  pageApprovalRequests: true,
  pageApprovalTransitions: true,
  pageAccessPasswords: true,
  pageUnlockGrants: true,
  pageProtectedAssets: true,
  contentExtensions: true,
  pageCollaborationRooms: true,
  pageCollaborationContributors: true,
  pageCollaborationConnections: true,
  agentProviderProfiles: true,
  agentProviderProfileVersions: true,
  agentProviderConfiguration: true,
  agentProviderGrants: true,
  agentProviderConformanceReports: true,
  agentSkills: true,
  agentSkillVersions: true,
  agentSkillGrants: true,
  agentSessions: true,
  agentLaunchHandoffs: true,
  agentMessages: true,
  agentRuns: true,
  agentEvents: true,
  agentSessionSkills: true,
  agentRunSkills: true,
  agentSkillUses: true,
  agentProposals: true,
  agentApprovals: true,
  agentActionExecutions: true,
  pageMutationOutbox: true,
  agentUsageLedger: true,
  agentQuotaDaily: true,
  agentQuotaReservations: true,
  agentArtifacts: true,
  agentBrowserTargets: true,
  agentProviderSecrets: true,
  agentUserSkillPreferences: true,
  agentMemories: true,
  pageKnowledgeProjections: true,
  agentConversationFolders: true,
  agentRunTasks: true,
  agentGoals: true,
  schemaLineage: true,
  siteLogoObjects: true,
  siteLogoRevisions: true,
  siteLogoState: true
}

function isMigration(value: unknown): value is Knex.Migration {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.up === 'function' && (candidate.down === undefined || typeof candidate.down === 'function')
}

const baseMigrationPath = (): string => path.join((WIKI as unknown as WikiDatabaseContext).SERVERPATH, 'db/migrations')
const requireMigration = createRequire(import.meta.url)

const migrationSource: Knex.MigrationSource<MigrationSpec> = {
  async getMigrations() {
    const directory = baseMigrationPath()
    const migrationFiles = (await fs.readdir(directory)).filter(file => file.endsWith('.ts'))
    return orderMigrationFiles(migrationFiles).map(file => ({ file }))
  },

  getMigrationName(migration) {
    return migrationLedgerName(migration.file)
  },

  async getMigration(migration) {
    const filename = `${migration.file}.ts`
    const loaded: unknown = requireMigration(path.join(baseMigrationPath(), filename))
    if (!isMigration(loaded)) {
      throw new TypeError(`Invalid migration module: ${filename}`)
    }
    return loaded
  }
}

export default migrationSource
