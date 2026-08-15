
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
