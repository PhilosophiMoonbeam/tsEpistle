import type { RequestAuthContext } from '../shared/agents/contracts.ts'


type WikiRecord = Record<string, unknown>
declare module 'express-session' {
  interface SessionData {
    pageUnlockEstablishedAt?: number
  }
}

declare global {
  namespace Express {
    interface User extends WikiRecord {
      id?: number
      permissions?: string[]
      ownershipUserId?: number | null
    }

    interface Request {
      authContext?: RequestAuthContext<User>
      apiKeyAuth?: {
        apiKeyId: number
        groupId: number
        expiresAt: number | null
        mcpResource: string | null
        mcpResourceVersion: number | null
        bearerToken: string | null
      }
    }
  }

  var WIKI: WikiRecord

  namespace NodeJS {
    interface Global {
      WIKI: WikiRecord
    }
  }
}

export {}
