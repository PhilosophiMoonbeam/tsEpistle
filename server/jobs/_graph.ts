import { z } from 'zod'

const GraphResponseSchema = z
  .object({
    errors: z
      .array(
        z
          .object({
            message: z.string().optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough()

interface GraphRequest {
  query: string
  variables?: Record<string, string>
}

export async function requestGraph(endpoint: string, query: string, variables?: Record<string, string>): Promise<Record<string, unknown>> {
  const request: GraphRequest = variables === undefined ? { query } : { query, variables }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  })

  if (!response.ok) {
    throw new Error(`Network request failed with status ${response.status} - "${response.statusText}"`)
  }

  const payload = GraphResponseSchema.parse(JSON.parse(await response.text()) as unknown)
  if (payload.errors !== undefined && payload.errors.length > 0) {
    const message = payload.errors[0]?.message
    throw new Error(typeof message === 'string' && message.length > 0 ? `Graph request failed: ${message}` : 'Graph request failed.')
  }

  return payload
}

export default requestGraph
