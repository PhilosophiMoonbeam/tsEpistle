import type { Request } from 'express'

import graphHelper from '../../helpers/graph.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import errors from '../../operations/errors.ts'
import { getDeveloperFlagsWorkspaceStore } from '../../operations/developer-flags.ts'
import systemOperations from '../../operations/system.ts'

interface ResolverContext {
  req: Request
}
export default {
  Query: {
    async system() {
      return {}
    }
  },
  Mutation: {
    async system() {
      return {}
    }
  },
  SystemQuery: {
    async flags(_obj: unknown, _args: Record<string, unknown>, context: ResolverContext) {
      return getDeveloperFlagsWorkspaceStore().legacyList(systemRequester(context.req))
    },
    info: systemOperations.getInfo
  },
  SystemMutation: {
    async updateFlags() {
      return graphHelper.generateError(
        new errors.ApplicationError('Developer flags now use reviewed workspace settings. Use /_api/developer-flags/workspace.', { status: 410 })
      )
    }
  }
}
