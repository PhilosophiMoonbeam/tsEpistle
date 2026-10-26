/** Browser consumers require only fetch's call signature, not runtime-specific static methods. */
export type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type JsonResponse = {
  readonly headers?: {
    get: (name: string) => string | null
    has?: (name: string) => boolean
  }
}

export const sameOriginJsonFetch = async <Input, Init, ResponseType extends JsonResponse>(
  fetchImpl: (input: Input, init: Init) => Promise<ResponseType>,
  input: Input,
  init: Init
): Promise<ResponseType> => fetchImpl(input, init)
