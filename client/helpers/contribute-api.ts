interface JsonHeaders {
  get: (name: string) => string | null
}

interface JsonResponse {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (input: string, init: {
  credentials: string
  headers: {
    Accept: string
  }
}) => Promise<JsonResponse>

interface ContributorRow {
  id: string
  source: string
  name: string
  joined: string
  website: string | null
  twitter: string | null
  avatar: string | null
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && (payload as { error: string }).error.length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && (payload as { message: string }).message.length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeContributor (row: unknown, fallbackMessage: string): ContributorRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const contributor = row as Record<string, unknown>
  const requiredStringFields = ['id', 'source', 'name', 'joined']
  if (requiredStringFields.some(field => typeof contributor[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }

  const optionalNullableStringFields = ['website', 'twitter', 'avatar']
  if (optionalNullableStringFields.some(field => contributor[field] !== null && typeof contributor[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: contributor.id as string,
    source: contributor.source as string,
    name: contributor.name as string,
    joined: contributor.joined as string,
    website: contributor.website as string | null,
    twitter: contributor.twitter as string | null,
    avatar: contributor.avatar as string | null
  }
}

function normalizeContributorsPayload (payload: unknown, fallbackMessage: string): ContributorRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeContributor(row, fallbackMessage))
}

export async function fetchContributors (fetchImpl: FetchImpl, fallbackMessage = 'Contributors response is invalid'): Promise<ContributorRow[]> {
  const response = await fetchImpl('/_api/contribute/contributors', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeContributorsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
