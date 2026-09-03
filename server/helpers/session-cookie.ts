import type { CookieOptions } from 'express-session'

export const sessionCookieOptions =
  (currentPublicHost: () => string): (() => CookieOptions) =>
  () => {
    let secure = false
    try {
      secure = new URL(currentPublicHost()).protocol === 'https:'
    } catch {
      secure = false
    }

    return {
      httpOnly: true,
      sameSite: 'lax',
      secure
    }
  }
