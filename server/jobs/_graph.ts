interface GraphRequest {
  query: string
  variables?: Record<string, string>
}

export async function requestGraph (
  endpoint: string,
  query: string,
  variables?: Record<string, string>
): Promise<unknown> {
  const request: GraphRequest = variables === undefined ? { query } : { query, variables }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  })
  const raw = await response.text()

  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (response.status >= 300) {
      throw new Error(`Network request failed with status ${response.status} - "${response.statusText}"`, { cause: error })
    }
    throw error
  }
}

export function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

export function asRecordArray (value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
}

export default requestGraph
