import Cookies from 'js-cookie'
import { jwtExpiration } from './jwt.ts'

type JsonResponse = {
  readonly headers?: {
    get: (name: string) => string | null
    has?: (name: string) => boolean
  }
}
let refreshPrincipal: (() => void) | undefined

export const registerJsonPrincipalRefresh = (refresh: () => void): void => {
  refreshPrincipal = refresh
}

const consumeRenewedJwt = (response: JsonResponse): void => {
  const headers = response.headers
  if (headers?.has?.('new-jwt') !== true) return
  const token = headers.get('new-jwt')
  if (!token) return

  const expiration = jwtExpiration(token)
  if (!refreshPrincipal) throw new Error('JSON principal refresh is not registered.')
  if (expiration <= Date.now() / 1000) throw new Error('Renewed JWT is expired.')

  Cookies.set('jwt', token, {
    expires: 365,
    secure: window.location.protocol === 'https:'
  })
  refreshPrincipal()
}

export const sameOriginJsonFetch = async <Input, Init, ResponseType extends JsonResponse>(
  fetchImpl: (input: Input, init: Init) => Promise<ResponseType>,
  input: Input,
  init: Init
): Promise<ResponseType> => {
  const response = await fetchImpl(input, init)
  consumeRenewedJwt(response)
  return response
}
