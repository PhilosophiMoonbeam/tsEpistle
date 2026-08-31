import type { Readable, Writable } from 'node:stream'

export type UnknownRecord = Record<string, unknown>

export interface WikiLogger {
  error(message: unknown, ...meta: unknown[]): void
  info(message: unknown, ...meta: unknown[]): void
  warn(message: unknown, ...meta: unknown[]): void
}

export interface WikiPage {
  id: number
  hash: string
  path: string
  localeCode: string
  title: string
  description: string
  contentType: string
  content: string
  safeContent: string
  render: string
  destinationHash: string
  destinationPath: string
  destinationLocaleCode: string
  authorId: number
  authorName: string
  authorEmail: string
  moveAuthorName: string
  moveAuthorEmail: string
  sourceRevision: string | number | bigint
  createdAt: Date | string
  updatedAt: Date | string
  extra: UnknownRecord
  isPublished: boolean | number
  editorKey: string
  tags: UnknownRecord[]
  injectMetadata(): string
  $relatedQuery(relation: string): Promise<UnknownRecord[]>
}

export interface WikiAsset {
  id: number
  path: string
  filename: string
  folderId: number | null
  destinationPath: string
  data: Buffer
  authorName: string
  authorEmail: string
  moveAuthorName: string
  moveAuthorEmail: string
}

export interface WikiUser extends Express.User {
  id: number
  email: string
  name: string
  password?: string
  isActive?: boolean
  isVerified?: boolean
}

export interface QueryBuilder<T> extends PromiseLike<T[]> {
  alias(alias: string): QueryBuilder<T>
  column(...columns: unknown[]): QueryBuilder<T>
  delete(): QueryBuilder<T>
  findById(id: unknown): QueryBuilder<T>
  findOne(criteria: UnknownRecord): Promise<T | undefined>
  first(...columns: string[]): Promise<T | undefined>
  from(table: string): QueryBuilder<T>
  insert(value: UnknownRecord): Promise<T>
  join(...args: unknown[]): QueryBuilder<T>
  leftJoin(...args: unknown[]): QueryBuilder<T>
  limit(limit: number): QueryBuilder<T>
  modify(callback: (builder: QueryBuilder<T>) => void): QueryBuilder<T>
  orderBy(column: string, direction?: string): QueryBuilder<T>
  orWhere(...args: unknown[]): QueryBuilder<T>
  patch(value: UnknownRecord): QueryBuilder<T>
  select(...columns: unknown[]): QueryBuilder<T>
  stream(): Readable
  where(...args: unknown[]): QueryBuilder<T>
  whereIn(column: string, values: readonly unknown[]): QueryBuilder<T>
  whereNot(criteria: UnknownRecord): QueryBuilder<T>
}

export interface KnexSchema {
  createTable(name: string, callback: (table: KnexTableBuilder) => void): Promise<void>
  dropTable(name: string): Promise<void>
  hasTable(name: string): Promise<boolean>
}

export interface KnexTableBuilder {
  index(columns: string[], name?: string): void
  integer(name: string): KnexColumnBuilder
  primary(columns: string[]): void
  text(name: string): KnexColumnBuilder
}

export interface KnexColumnBuilder {
  index(): KnexColumnBuilder
  notNullable(): KnexColumnBuilder
  primary(): KnexColumnBuilder
}

export interface Knex extends QueryBuilder<UnknownRecord> {
  (...args: unknown[]): QueryBuilder<UnknownRecord>
  raw<T = unknown>(sql: string, bindings?: readonly unknown[]): Promise<T>
  schema: KnexSchema
}

export interface WikiModels {
  knex: Knex
  assetFolders: {
    getAllPaths(): Promise<Record<number, string>>
    query(): QueryBuilder<UnknownRecord>
  }
  assets: {
    query(): QueryBuilder<WikiAsset>
    upload(value: UnknownRecord): Promise<unknown>
  }
  comments: { query(): QueryBuilder<UnknownRecord> }
  editors: { getDefaultEditor(): Promise<string> }
  pages: {
    cleanHTML(value: string): string
    createPage(value: UnknownRecord): Promise<WikiPage>
    deletePage(value: UnknownRecord): Promise<void>
    getPageFromDb(value: UnknownRecord): Promise<WikiPage | null>
    movePage(value: UnknownRecord): Promise<void>
    parseMetadata(content: string, filename: string): UnknownRecord
    query(): QueryBuilder<WikiPage>
    updatePage(value: UnknownRecord): Promise<WikiPage>
  }
  users: {
    getRootUser(): Promise<WikiUser>
    processProfile(value: UnknownRecord): Promise<WikiUser>
    query(): QueryBuilder<WikiUser>
  }
}

export interface WikiRuntime {
  Error: {
    AuthAccountBanned: new (...args: unknown[]) => Error
    AuthAccountNotVerified: new (...args: unknown[]) => Error
    AuthLoginFailed: new (...args: unknown[]) => Error
    SearchActivationFailed: new (...args: unknown[]) => Error
  }
  IS_DEBUG: boolean
  ROOTPATH: string
  auth: { groups: readonly string[] }
  config: {
    dataPath: string
    db: { type: string }
    flags: { ldapdebug: boolean }
    host: string
    lang: {
      code: string
      namespaces: string[]
      namespacing: boolean
    }
    search: { maxHits: number }
  }
  data: {
    commentProvider: {
      config: {
        akismet: string
        minDelay: number
      }
    }
  }
  logger: WikiLogger
  models: WikiModels
}

export const wiki = WIKI as unknown as WikiRuntime

export const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

export interface AuthenticationConfig {
  [key: string]: unknown
  acceptedClockSkewMs: number
  acrValues: string
  authnContext: string
  authnRequestBinding: string
  authorizationURL: string
  baseUrl: string
  bindCredentials: string
  bindDn: string
  callbackURL: string
  casUrl: string
  casVersion: string
  cert: string
  clientId: string
  clientSecret: string
  cookieEncryptionKeyString: string
  decryptionPvk: string
  digestAlgorithm: string
  disableRequestedAuthnContext: boolean
  displayNameAttribute: string
  displayNameClaim: string
  domain: string
  emailAttribute: string
  emailClaim: string
  enableCSRFProtection: boolean
  enterpriseDomain: string
  enterpriseUserEndpoint: string
  entryPoint: string
  forceAuthn: boolean
  groupDnProperty: string
  groupNameField: string
  groupSearchBase: string
  groupSearchFilter: string
  groupSearchScope: string
  groupsClaim: string
  guildId: string
  host: string
  hostedDomain: string
  identifierFormat: string
  idp: string
  issuer: string
  key: string
  logoutURL: string
  logoutUpstream: boolean
  logoutUpstreamRedirectLegacy: boolean
  mapGroups: boolean
  mappingDisplayName: string
  mappingEmail: string
  mappingGroups: string
  mappingPicture: string
  mappingUID: string
  passive: boolean
  pictureClaim: string
  privateKey: string
  providerName: string
  racComparison: string
  realm: string
  scope: string[]
  searchBase: string
  searchFilter: string
  signatureAlgorithm: string
  siteURL: string
  skipRequestCompression: boolean
  skipUserProfile: boolean
  team: string
  tlsCertPath: string
  tlsEnabled: boolean
  tokenURL: string
  uniqueIdAttribute: string
  url: string
  useEnterprise: boolean
  useQueryStringForAccessToken: boolean
  userIdClaim: string
  userInfoURL: string
  verifyTLSCertificate: boolean
  wantAssertionsSigned: boolean
}

export interface PassportRegistry {
  use(key: string, strategy: unknown): void
  use(strategy: unknown): void
}

export interface AuthenticationPlugin {
  init(passport: PassportRegistry, conf: AuthenticationConfig): Promise<void> | void
}

export interface RendererChild {
  key: string
  order: number
  step: string
  config: UnknownRecord
}

export interface RendererContext<C extends UnknownRecord = UnknownRecord> {
  children: RendererChild[]
  config: C
}

export interface StorageConfig extends UnknownRecord {
  alwaysNamespace: boolean
  authMode: string
  authType: string
  basePath: string
  basicPassword: string
  basicUsername: string
  branch: string
  createDailyBackups: boolean
  defaultEmail: string
  defaultName: string
  endpoint: string
  gitBinaryPath: string
  host: string
  localRepoPath: string
  passphrase: string
  password: string
  path: string
  port: number
  privateKey: string
  region: string
  repoUrl: string
  s3BucketEndpoint: boolean
  s3ForcePathStyle: boolean
  sshPrivateKeyContent: string
  sshPrivateKeyMode: string
  sshPrivateKeyPath: string
  sslEnabled: boolean
  storageTier: string
  username: string
  verifySSL: boolean
}

export type StorageActionOutcome = 'succeeded' | 'partial' | 'failed'

export type StorageActionItemOutcome = 'succeeded' | 'failed' | 'conflict'

export type StorageActionFormat = 'okf' | 'legacyV1' | 'legacyWiki' | 'plain' | 'invalid'

export interface StorageActionFormatCounts {
  okf: number
  legacyV1: number
  legacyWiki: number
  plain: number
  invalid: number
}

export interface StorageActionItem {
  kind: 'page' | 'asset'
  path: string
  outcome: StorageActionItemOutcome
  format: StorageActionFormat | null
  message: string | null
  diagnostics: string[]
}

export interface StorageActionSummary {
  targetKey: string
  handler: string
  outcome: StorageActionOutcome
  total: number
  succeeded: number
  failed: number
  formats: StorageActionFormatCounts
  items: StorageActionItem[]
  startedAt: string
  completedAt: string
  message: string
}

export type StorageLastOperation = StorageActionSummary

export const STORAGE_ACTION_ITEM_LIMIT = 50
export const STORAGE_ACTION_PATH_LIMIT = 512
export const STORAGE_ACTION_MESSAGE_LIMIT = 512
export const STORAGE_ACTION_DIAGNOSTIC_LIMIT = 8

const storageActionFormats: StorageActionFormat[] = ['okf', 'legacyV1', 'legacyWiki', 'plain', 'invalid']

export const emptyStorageActionFormats = (): StorageActionFormatCounts => ({
  okf: 0,
  legacyV1: 0,
  legacyWiki: 0,
  plain: 0,
  invalid: 0
})

export type StoragePluginActionResult = readonly unknown[] | StorageActionSummary | void

export function storageActionFormat(value: unknown): StorageActionFormat | null {
  if (value === 'okf_valid') return 'okf'
  if (value === 'legacy_v1') return 'legacyV1'
  if (value === 'legacy_wiki') return 'legacyWiki'
  if (value === 'plain_markdown') return 'plain'
  if (value === 'okf_invalid') return 'invalid'
  return storageActionFormats.includes(value as StorageActionFormat) ? value as StorageActionFormat : null
}

export function boundedStorageActionText(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== 'string') return fallback
  const normalized = value.replaceAll(/[\r\n\t]+/gu, ' ').trim()
  return normalized.length > 0 ? normalized.slice(0, STORAGE_ACTION_MESSAGE_LIMIT) : fallback
}

export function boundedStorageActionPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replaceAll('\\', '/').slice(0, STORAGE_ACTION_PATH_LIMIT)
}

export function isStorageActionSummary(value: unknown): value is StorageActionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<StorageActionSummary>
  return typeof summary.targetKey === 'string' &&
    typeof summary.handler === 'string' &&
    (summary.outcome === 'succeeded' || summary.outcome === 'partial' || summary.outcome === 'failed') &&
    Number.isInteger(summary.total) &&
    Number.isInteger(summary.succeeded) &&
    Number.isInteger(summary.failed) &&
    !!summary.formats &&
    typeof summary.formats === 'object' &&
    Array.isArray(summary.items) &&
    typeof summary.startedAt === 'string' &&
    typeof summary.completedAt === 'string' &&
    typeof summary.message === 'string'
}

export interface StorageContext<C extends StorageConfig = StorageConfig> {
  config: C
  mode?: string
}

export interface StoragePlugin<C extends StorageConfig = StorageConfig, Context extends StorageContext<C> = StorageContext<C>> {
  activated(this: Context): Promise<void>
  deactivated(this: Context): Promise<void>
  init(this: Context): Promise<void>
  created?(this: Context, page: WikiPage): Promise<void>
  updated?(this: Context, page: WikiPage): Promise<void>
  deleted?(this: Context, page: WikiPage): Promise<void>
  renamed?(this: Context, page: WikiPage): Promise<void>
  assetUploaded?(this: Context, asset: WikiAsset): Promise<void>
  assetDeleted?(this: Context, asset: WikiAsset): Promise<void>
  assetRenamed?(this: Context, asset: WikiAsset): Promise<void>
  getLocalLocation?(this: Context, asset: WikiAsset): Promise<string | void>
  sync?(this: Context, options?: { manual: boolean }): Promise<StoragePluginActionResult>
  dump?(this: Context): Promise<StoragePluginActionResult>
  backup?(this: Context): Promise<StoragePluginActionResult>
  importAll?(this: Context): Promise<StoragePluginActionResult>
  exportAll?(this: Context): Promise<StoragePluginActionResult>
}

export interface SearchConfig extends UnknownRecord {
  AnalysisSchemeLang: string
  apiVersion: string
  accessKeyId: string
  adminKey: string
  analyzer: string
  apiKey: string
  appId: string
  dictLanguage: string
  domain: string
  endpoint: string
  hosts: string
  indexName: string
  region: string
  secretAccessKey: string
  serviceName: string
  sniffInterval: number
  sniffOnStart: boolean
}

export interface SearchOptions extends UnknownRecord {
  locale?: string
  path?: string
}

export interface SearchContext<C extends SearchConfig = SearchConfig, Client = unknown> {
  client: Client
  config: C
}

export interface SearchResult {
  results: unknown[]
  suggestions: string[]
  totalHits: number
}

export interface SearchPlugin<C extends SearchConfig = SearchConfig, Context extends SearchContext<C> = SearchContext<C>> {
  activate(this: Context): Promise<void>
  deactivate(this: Context): Promise<void>
  init(this: Context): Promise<void>
  query(this: Context, query: string, options: SearchOptions): Promise<SearchResult>
  created(this: Context, page: WikiPage): Promise<void>
  updated(this: Context, page: WikiPage): Promise<void>
  deleted(this: Context, page: WikiPage): Promise<void>
  renamed(this: Context, page: WikiPage): Promise<void>
  rebuild(this: Context): Promise<void>
}

export type WritableIndexStream = Writable
