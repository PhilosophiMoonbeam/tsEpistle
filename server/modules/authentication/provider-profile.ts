import _ from 'lodash'

export type ProviderProfileFields = Partial<Record<'location' | 'jobTitle' | 'pronouns', string>>

/** Only these native profile columns may be supplied by a provider. */
export function boundedProviderProfile(value: unknown): ProviderProfileFields {
  const result: ProviderProfileFields = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
  for (const field of ['location', 'jobTitle', 'pronouns'] as const) {
    if (!Object.hasOwn(value, field)) continue
    const text: unknown = Reflect.get(value, field)
    if (typeof text === 'string') result[field] = text.trim().slice(0, 255)
  }
  return result
}

export function mappedProviderProfile(
  source: unknown,
  mappings: Record<'location' | 'jobTitle' | 'pronouns', unknown>,
  missingClears = false
): ProviderProfileFields {
  const values: Record<string, unknown> = {}
  for (const field of ['location', 'jobTitle', 'pronouns'] as const) {
    const mapping = mappings[field]
    if (typeof mapping !== 'string' || !mapping.trim()) continue
    const value: unknown = _.get(source, mapping)
    if (value === undefined && missingClears) values[field] = ''
    else values[field] = Array.isArray(value) && value.length === 1 ? value[0] : value
  }
  return boundedProviderProfile(values)
}

export function samlEmailVerified(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length !== 1) return false
    value = value[0]
  }
  return value === true || (typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase()))
}
