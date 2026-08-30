export type JwtPayload = Record<string, unknown>

export const decodeJwtPayload = (token: string): JwtPayload => {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('JWT payload is missing.')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const decoded: unknown = JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')))
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('JWT payload is invalid.')
  return decoded as JwtPayload
}

export const jwtExpiration = (token: string): number => {
  const expiration = decodeJwtPayload(token).exp
  if (typeof expiration !== 'number' || !Number.isFinite(expiration)) throw new Error('JWT expiration is invalid.')
  return expiration
}
