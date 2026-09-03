import _ from 'lodash'
import path from 'node:path'
import knexModule, { type Knex } from 'knex'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import Objection from 'objection'
import PGPubSub from 'pg-pubsub'
import migrationSource from '../db/migrator-source.ts'
import migrateFromBeta from '../db/beta/index.ts'
import { preflightMigrations } from '../db/migration-preflight.ts'
import { assertSupportedPostgresVersion } from '../db/postgres-version.ts'
const { knex: createKnex } = knexModule

interface SslOptions extends Record<string, unknown> {
  auto?: boolean
  rejectUnauthorized?: boolean
  ca?: string | Buffer
  cert?: string | Buffer
  key?: string | Buffer
  pfx?: string | Buffer
}

interface DbConfig {
  host: string | number
  user: string | number
  pass: string | number
  db: string | number
  port: number
  ssl: boolean | string | number
  sslOptions: SslOptions
  schema?: string
  type: string
}

interface NetworkConnectionConfig {
  user: string
  password: string
  database: string
  ssl?: SslOptions
  host: string
  port: number
}

type DatabaseConnectionConfig = string | NetworkConnectionConfig
type DatabaseRow = Record<string, unknown>
type KnexInstance = Knex<DatabaseRow, unknown[]>
interface PoolConnection {
  query(statement: string): Promise<unknown>
}
interface NotificationPayload {
  event: string
  source: string
  value: unknown
}

export interface InitializedDatabase {
  [key: string]: unknown
  Objection: typeof Objection
  knex: KnexInstance
  listener: PGPubSub | null
  onReady: Promise<boolean>
  init(): Promise<InitializedDatabase>
  subscribeToNotifications(): Promise<void>
  unsubscribeToNotifications(): Promise<void>
  notifyViaDB(event: string, value: unknown): void
}

interface DatabaseService {
  Objection: typeof Objection
  knex: KnexInstance | null
  listener: PGPubSub | null
  onReady: Promise<boolean> | null
  init(): Promise<InitializedDatabase>
  subscribeToNotifications(): Promise<void>
  unsubscribeToNotifications(): Promise<void>
  notifyViaDB(event: string, value: unknown): void
}

interface WikiContext {
  INSTANCE_ID: string
  IS_DEBUG: boolean
  IS_MASTER: boolean
  ROOTPATH: string
  SERVERPATH: string
  auth: { subscribeToEvents(): void }
  config: { db: DbConfig; ha: boolean | string | number; pool: Record<string, unknown> }
  configSvc: { subscribeToEvents(): void }
  events: {
    inbound: { emit(event: string, value: unknown): void; removeAllListeners(): void }
    outbound: { offAny(listener: (event: string, value: unknown) => void): void; onAny(listener: (event: string, value: unknown) => void): void }
  }
  logger: { debug(message: unknown): void; error(message: unknown): void; info(message: string): void; warn(message: string): void }
  models: { listener: PGPubSub | null; pages: { subscribeToEvents(): void } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function isNetworkConnection(config: DatabaseConnectionConfig): config is NetworkConnectionConfig {
  return typeof config !== 'string' && 'host' in config
}
function sslFile(value: string | Buffer, rootPath: string): string | Buffer {
  return typeof value === 'string' ? fs.readFileSync(path.resolve(rootPath, value)) : value
}
function isNotificationPayload(value: unknown): value is NotificationPayload {
  return isRecord(value) && typeof value.event === 'string' && typeof value.source === 'string'
}
function connectionErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (isRecord(error) && typeof error.code === 'string') {
    const address = typeof error.address === 'string' ? error.address : ''
    const port = typeof error.port === 'string' || typeof error.port === 'number' ? error.port : ''
    return `${error.code} ${address}:${port}`
  }
  return error.message
}
async function loadModels(directory: string): Promise<Record<string, unknown>> {
  const models: Record<string, unknown> = {}
  const entries = await fs.promises.readdir(directory, { withFileTypes: true })
  const modelFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && entry.name !== 'moduleTypes.ts')
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of modelFiles) {
    // Runtime-selected model registry; each model module has a default class export.
    const loaded: unknown = await import(pathToFileURL(path.join(directory, entry.name)).href)
    if (!isRecord(loaded) || !('default' in loaded)) {
      throw new TypeError(`Model module ${entry.name} does not have a default export`)
    }
    models[path.basename(entry.name, '.ts')] = loaded.default
  }
  return models
}
const wiki = WIKI as unknown as WikiContext
/**
 * ORM DB module
 */
const database: DatabaseService = {
  Objection,
  knex: null,
  listener: null,
  onReady: null,
  /**
   * Initialize DB
   *
   * @return     {Object}  DB instance
   */
  async init(): Promise<InitializedDatabase> {
    const dbClient = 'pg'
    const dbConfig: DatabaseConnectionConfig =
      !_.isEmpty(process.env.DATABASE_URL) && process.env.DATABASE_URL
        ? process.env.DATABASE_URL
        : {
            host: wiki.config.db.host.toString(),
            user: wiki.config.db.user.toString(),
            password: wiki.config.db.pass.toString(),
            database: wiki.config.db.db.toString(),
            port: wiki.config.db.port
          }

    // Handle SSL Options

    let dbUseSSL = wiki.config.db.ssl === true || wiki.config.db.ssl === 'true' || wiki.config.db.ssl === 1 || wiki.config.db.ssl === '1'
    let sslOptions: true | SslOptions
    if (dbUseSSL && isNetworkConnection(dbConfig) && _.get(wiki.config.db, 'sslOptions.auto', null) === false) {
      sslOptions = wiki.config.db.sslOptions
      sslOptions.rejectUnauthorized = sslOptions.rejectUnauthorized !== false
      if (typeof sslOptions.ca === 'string' && !sslOptions.ca.startsWith('-----')) sslOptions.ca = sslFile(sslOptions.ca, wiki.ROOTPATH)
      if (sslOptions.cert) sslOptions.cert = sslFile(sslOptions.cert, wiki.ROOTPATH)
      if (sslOptions.key) sslOptions.key = sslFile(sslOptions.key, wiki.ROOTPATH)
      if (sslOptions.pfx) sslOptions.pfx = sslFile(sslOptions.pfx, wiki.ROOTPATH)
    } else {
      sslOptions = true
    }

    // Handle inline SSL CA Certificate mode
    const inlineSslCa = process.env.DB_SSL_CA
    if (inlineSslCa) {
      const chunks: string[] = []
      for (let i = 0, charsLength = inlineSslCa.length; i < charsLength; i += 64) {
        chunks.push(inlineSslCa.substring(i, i + 64))
      }

      dbUseSSL = true
      sslOptions = {
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\n' + chunks.join('\n') + '\n-----END CERTIFICATE-----\n'
      }
    }

    if (wiki.config.db.type !== 'postgres') {
      throw new Error(`Unsupported database type ${wiki.config.db.type}. tsEpistle requires PostgreSQL.`)
    }
    if (dbUseSSL && isNetworkConnection(dbConfig)) {
      dbConfig.ssl = sslOptions === true ? { rejectUnauthorized: true } : sslOptions
    }

    // Initialize Knex
    const knex = createKnex<DatabaseRow, unknown[]>({
      client: dbClient,
      useNullAsDefault: false,
      asyncStackTraces: wiki.IS_DEBUG,
      connection: dbConfig,
      pool: {
        ...wiki.config.pool,
        afterCreate(conn: PoolConnection, done: (error?: Error) => void) {
          let query = conn.query(`set application_name = 'tsEpistle'`)
          if (wiki.config.db.schema && wiki.config.db.schema !== 'public') {
            query = query.then(() => conn.query(`set search_path TO ${wiki.config.db.schema}, public;`))
          }
          void query.then(
            () => done(),
            error => done(error instanceof Error ? error : new Error(String(error)))
          )
        }
      },
      debug: wiki.IS_DEBUG
    })
    this.knex = knex
    Objection.Model.knex(knex)

    // Load DB Models

    const models = await loadModels(path.join(wiki.SERVERPATH, 'models'))

    // Set init tasks
    let conAttempts = 0
    const initTasks = {
      // -> Attempt initial connection
      async connect() {
        try {
          wiki.logger.info('Connecting to database...')
          await knex.raw('SELECT 1 + 1;')
          wiki.logger.info('Database Connection Successful [ OK ]')
        } catch (error) {
          if (conAttempts < 10) {
            wiki.logger.error(`Database Connection Error: ${connectionErrorMessage(error)}`)
            wiki.logger.warn(`Will retry in 3 seconds... [Attempt ${++conAttempts} of 10]`)
            await new Promise<void>(resolve => setTimeout(resolve, 3000))
            await initTasks.connect()
          } else {
            throw error
          }
        }
      },
      async verifyPostgresVersion() {
        if (wiki.config.db.type !== 'postgres') return
        const version = await assertSupportedPostgresVersion(knex)
        wiki.logger.info(`PostgreSQL ${version.version} is within the supported ${version.major} server line [ OK ]`)
      },
      // -> Migrate DB Schemas
      async syncSchemas() {
        return knex.migrate.latest({
          tableName: 'migrations',
          migrationSource
        })
      },
      // -> Migrate DB Schemas from beta
      async migrateFromBeta() {
        return migrateFromBeta.migrate(knex)
      },
      // -> Refuse unsafe schemas before the legacy beta migrator can write
      async preflightLegacyMigrations() {
        return preflightMigrations(knex, migrationSource, {
          legacyMigrationNames: await migrateFromBeta.getLegacyMigrationNames()
        })
      },
      // -> Recheck the normalized ledger before current Knex migrations write
      async preflightCurrentMigrations() {
        return preflightMigrations(knex, migrationSource)
      }
    }

    const initTasksQueue = wiki.IS_MASTER
      ? [
          initTasks.connect,
          initTasks.verifyPostgresVersion,
          initTasks.preflightLegacyMigrations,
          initTasks.migrateFromBeta,
          initTasks.preflightCurrentMigrations,
          initTasks.syncSchemas
        ]
      : [async () => {}]

    // Perform init tasks

    wiki.logger.info(`Using database driver ${dbClient} for ${wiki.config.db.type} [ OK ]`)
    const onReady = (async () => {
      for (const task of initTasksQueue) await task()
      return true
    })()
    this.onReady = onReady
    return { ...this, ...models, knex, onReady }
  },
  /**
   * Subscribe to database LISTEN / NOTIFY for multi-instances events
   */
  async subscribeToNotifications() {
    const useHA =
      wiki.config.ha === true ||
      (typeof wiki.config.ha === 'string' && wiki.config.ha.toLowerCase() === 'true') ||
      wiki.config.ha === 1 ||
      wiki.config.ha === '1'
    if (!useHA) return

    const knex = this.knex
    if (!knex) throw new Error('Database must be initialized before subscribing to notifications')
    const listener = new PGPubSub(knex.client.connectionSettings, {
      log(ev: unknown) {
        wiki.logger.debug(ev)
      }
    })
    try {
      await listener.addChannel('wiki', (payload: unknown) => {
        if (isNotificationPayload(payload) && payload.source !== wiki.INSTANCE_ID) {
          wiki.logger.info(`Received event ${payload.event} from instance ${payload.source}: [ OK ]`)
          wiki.events.inbound.emit(payload.event, payload.value)
        }
      })
    } catch (error) {
      await listener.close()
      throw error
    }
    this.listener = listener
    wiki.events.outbound.onAny(this.notifyViaDB)

    // -> Listen to inbound events

    wiki.auth.subscribeToEvents()
    wiki.configSvc.subscribeToEvents()
    wiki.models.pages.subscribeToEvents()

    wiki.logger.info(`High-Availability Listener initialized successfully: [ OK ]`)
  },
  /**
   * Unsubscribe from database LISTEN / NOTIFY
   */
  async unsubscribeToNotifications() {
    const listener = this.listener
    if (listener) {
      wiki.events.outbound.offAny(this.notifyViaDB)
      wiki.events.inbound.removeAllListeners()
      await listener.close()
      this.listener = null
    }
  },
  /**
   * Publish event via database NOTIFY
   *
   * @param {string} event Event fired
   * @param {object} value Payload of the event
   */
  notifyViaDB(event: string, value: unknown) {
    const listener = wiki.models.listener
    if (listener) {
      void listener
        .publish('wiki', {
          source: wiki.INSTANCE_ID,
          event,
          value
        })
        .catch((error: unknown) => {
          wiki.logger.error({
            message: 'Failed to publish High-Availability notification',
            channel: 'wiki',
            event,
            error: connectionErrorMessage(error)
          })
        })
    }
  }
}

export default database
