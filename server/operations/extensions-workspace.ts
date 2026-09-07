import type { Knex } from 'knex'
import type { ExtensionWorkspaceExtension, ExtensionsWorkspace } from '../../shared/extensions-workspace.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'

type Authority = (transaction: Knex.Transaction, requester: SystemRequester, lock?: boolean, now?: Date) => Promise<unknown>

interface ExtensionsRuntime {
  inspect(): Promise<ExtensionWorkspaceExtension[]>
}

interface Dependencies {
  db: Knex
  extensions: ExtensionsRuntime
  now?: () => Date
  requireAuthority?: Authority
}

export interface ExtensionsWorkspaceStore {
  inspect(requester: SystemRequester): Promise<ExtensionsWorkspace>
}

export const createExtensionsWorkspaceStore = ({ db, extensions, now, requireAuthority = requireSystemAuthority }: Dependencies): ExtensionsWorkspaceStore => ({
  async inspect(requester: SystemRequester): Promise<ExtensionsWorkspace> {
    const transaction = await db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      await requireAuthority(transaction, requester)
      await transaction.commit()
    } catch (error) {
      await transaction.rollback()
      throw error
    }
    const observed = await extensions.inspect()
    return { observedAt: (now?.() ?? new Date()).toISOString(), extensions: observed }
  }
})

interface Runtime {
  models: { knex: Knex }
  extensions: ExtensionsRuntime
}

let database: Knex | undefined
let store: ExtensionsWorkspaceStore | undefined

export const getExtensionsWorkspaceStore = () => {
  const wiki = WIKI as unknown as Runtime
  if (!store || database !== wiki.models.knex) {
    const currentDatabase = wiki.models.knex
    database = currentDatabase
    store = createExtensionsWorkspaceStore({ db: currentDatabase, extensions: wiki.extensions })
  }
  return store
}
