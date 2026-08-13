import { randomBytes } from 'node:crypto'
import passportJwt from 'passport-jwt'

interface JwtRequest { cookies?: Record<string, unknown>, path: string }
const securityHelper = {
  sanitizeCommitUser (user: unknown): void { void user },
  async generateToken (length: number): Promise<string> {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      randomBytes(length, (error, value) => { if (error) reject(error); else resolve(value) })
    })
    return buffer.toString('hex')
  },
  extractJWT: passportJwt.ExtractJwt.fromExtractors([
    passportJwt.ExtractJwt.fromAuthHeaderAsBearerToken(),
    (req: JwtRequest): string | null => {
      const cookieToken = req?.cookies?.jwt
      if (req.path.toLowerCase() === '/u') return null
      return typeof cookieToken === 'string' ? cookieToken : null
    }
  ])
}

export default securityHelper
