import { randomBytes } from 'node:crypto'
import passportJwt from 'passport-jwt'
import { apiAccessContract, isApiKeyTransportPath } from '../../shared/api-access.ts'

interface JwtRequest {
  cookies?: Record<string, unknown>
  path: string
  headers?: { authorization?: string | undefined }
}

const bearerExtractor = passportJwt.ExtractJwt.fromAuthHeaderAsBearerToken()
const isApiKeyPath = (path: string): boolean => isApiKeyTransportPath(path) || path === apiAccessContract.mcpPath

const securityHelper = {
  sanitizeCommitUser (user: unknown): void { void user },
  async generateToken (length: number): Promise<string> {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      randomBytes(length, (error, value) => { if (error) reject(error); else resolve(value) })
    })
    return buffer.toString('hex')
  },
  extractJWT: (req: JwtRequest): string | null => {
    if (isApiKeyPath(req.path)) {
      const bearer = bearerExtractor(req as unknown as Parameters<typeof bearerExtractor>[0])
      if (bearer) return bearer
    }
    const cookieToken = req?.cookies?.jwt
    return typeof cookieToken === 'string' ? cookieToken : null
  }
}

export default securityHelper
