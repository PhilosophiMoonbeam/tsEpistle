import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { openApiDocument } from '../controllers/api-v1/openapi.ts'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

const baselinePath = path.resolve('server/contracts/openapi-v1-baseline.json')
const generatedDirectory = path.resolve('node_modules/.cache/wiki')
const generatedPath = path.join(generatedDirectory, 'openapi-v1.json')

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareAddedRequiredParameters(currentValue: JsonValue[], startIndex: number, location: string, failures: string[], currentDocument: JsonValue) {
  for (let index = startIndex; index < currentValue.length; index += 1) {
    const parameterValue = currentValue[index]
    if (parameterValue === undefined) continue
    const parameter = resolveReference(currentDocument, parameterValue)
    if (isRecord(parameter) && parameter.required === true && (parameter.in === 'query' || parameter.in === 'path' || parameter.in === 'header')) {
      failures.push(`${location}[${index}] added required ${parameter.in} parameter ${JSON.stringify(parameter.name)}`)
    }
  }
}

function compareArray(baselineValue: JsonValue[], currentValue: JsonValue[], location: string, failures: string[], currentDocument: JsonValue) {
  if (location.endsWith('.required') || location.endsWith('.enum') || location.endsWith('.type')) {
    for (const value of baselineValue) {
      if (!currentValue.some(candidate => isDeepStrictEqual(candidate, value))) {
        failures.push(`${location} no longer includes ${JSON.stringify(value)}`)
      }
    }
    return
  }
  for (const [index, value] of baselineValue.entries()) {
    const currentChild = currentValue[index]
    if (currentChild === undefined) {
      failures.push(`${location}[${index}] was removed`)
    } else {
      compareCompatible(value, currentChild, `${location}[${index}]`, failures, currentDocument)
    }
  }
  if (location.endsWith('.parameters')) {
    compareAddedRequiredParameters(currentValue, baselineValue.length, location, failures, currentDocument)
  }
}

function compareConstraint(baselineValue: number, currentValue: number, location: string, failures: string[]): boolean {
  if (location.endsWith('.minimum') || location.endsWith('.exclusiveMinimum') || location.endsWith('.minLength')) {
    if (currentValue > baselineValue) failures.push(`${location} became more restrictive`)
    return true
  }
  if (location.endsWith('.maximum') || location.endsWith('.exclusiveMaximum') || location.endsWith('.maxLength')) {
    if (currentValue < baselineValue) failures.push(`${location} became more restrictive`)
    return true
  }
  return false
}

function compareCompatible(baselineValue: JsonValue, currentValue: JsonValue, location: string, failures: string[], currentDocument: JsonValue) {
  if (Array.isArray(baselineValue)) {
    if (!Array.isArray(currentValue)) {
      failures.push(`${location} changed from an array`)
      return
    }
    compareArray(baselineValue, currentValue, location, failures, currentDocument)
    return
  }
  if (isRecord(baselineValue)) {
    if (!isRecord(currentValue)) {
      failures.push(`${location} changed from an object`)
      return
    }
    for (const [key, value] of Object.entries(baselineValue)) {
      const currentChild = currentValue[key]
      if (currentChild === undefined) {
        failures.push(`${location}.${key} was removed`)
      } else {
        compareCompatible(value, currentChild, `${location}.${key}`, failures, currentDocument)
      }
    }
    if (!('parameters' in baselineValue) && Array.isArray(currentValue.parameters)) {
      compareAddedRequiredParameters(currentValue.parameters, 0, `${location}.parameters`, failures, currentDocument)
    }
    return
  }
  if (typeof baselineValue === 'number' && typeof currentValue === 'number' && compareConstraint(baselineValue, currentValue, location, failures)) {
    return
  }
  if (!isDeepStrictEqual(baselineValue, currentValue)) {
    failures.push(`${location} changed from ${JSON.stringify(baselineValue)} to ${JSON.stringify(currentValue)}`)
  }
}

function resolvePointer(document: JsonValue, reference: string): JsonValue | undefined {
  if (!reference.startsWith('#/')) return undefined
  let value: JsonValue | undefined = document
  for (const encodedToken of reference.slice(2).split('/')) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === undefined) return undefined
    if (Array.isArray(value)) {
      const index = Number(token)
      value = Number.isInteger(index) ? value[index] : undefined
    } else if (isRecord(value)) {
      value = value[token]
    } else {
      return undefined
    }
  }
  return value
}

function resolveReference(document: JsonValue, value: JsonValue): JsonValue {
  let resolved = value
  const seen = new Set<string>()
  while (isRecord(resolved) && typeof resolved.$ref === 'string' && !seen.has(resolved.$ref)) {
    const reference = resolved.$ref
    const target = resolvePointer(document, reference)
    if (target === undefined) break
    seen.add(reference)
    resolved = target
  }
  return resolved
}

function requiredNames(schema: JsonObject): Set<string> {
  const required = schema.required
  return new Set(Array.isArray(required) ? required.filter((value): value is string => typeof value === 'string') : [])
}

function alreadyCompared(baselineSchema: JsonObject, currentSchema: JsonObject, compared: WeakMap<JsonObject, WeakSet<JsonObject>>): boolean {
  const currentSchemas = compared.get(baselineSchema)
  if (currentSchemas?.has(currentSchema)) return true
  if (currentSchemas) currentSchemas.add(currentSchema)
  else compared.set(baselineSchema, new WeakSet([currentSchema]))
  return false
}

function compareRequestSchema(
  baselineValue: JsonValue,
  currentValue: JsonValue,
  baselineDocument: JsonValue,
  currentDocument: JsonValue,
  location: string,
  failures: string[],
  compared: WeakMap<JsonObject, WeakSet<JsonObject>>
) {
  const baselineSchema = resolveReference(baselineDocument, baselineValue)
  const currentSchema = resolveReference(currentDocument, currentValue)
  if (!isRecord(baselineSchema) || !isRecord(currentSchema)) return
  if (alreadyCompared(baselineSchema, currentSchema, compared)) return

  const baselineRequired = requiredNames(baselineSchema)
  for (const name of requiredNames(currentSchema)) {
    if (!baselineRequired.has(name)) {
      failures.push(`${location}.required now includes request property ${JSON.stringify(name)}`)
    }
  }

  const baselineProperties = baselineSchema.properties
  const currentProperties = currentSchema.properties
  if (baselineProperties !== undefined && currentProperties !== undefined && isRecord(baselineProperties) && isRecord(currentProperties)) {
    for (const [name, property] of Object.entries(baselineProperties)) {
      const currentProperty = currentProperties[name]
      if (currentProperty !== undefined) {
        compareRequestSchema(property, currentProperty, baselineDocument, currentDocument, `${location}.properties.${name}`, failures, compared)
      }
    }
  }

  for (const keyword of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else'] as const) {
    const baselineChild = baselineSchema[keyword]
    const currentChild = currentSchema[keyword]
    if (baselineChild !== undefined && currentChild !== undefined) {
      compareRequestSchema(baselineChild, currentChild, baselineDocument, currentDocument, `${location}.${keyword}`, failures, compared)
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    const baselineChildren = baselineSchema[keyword]
    const currentChildren = currentSchema[keyword]
    if (Array.isArray(baselineChildren) && Array.isArray(currentChildren)) {
      for (const [index, child] of baselineChildren.entries()) {
        const currentChild = currentChildren[index]
        if (currentChild !== undefined) {
          compareRequestSchema(child, currentChild, baselineDocument, currentDocument, `${location}.${keyword}[${index}]`, failures, compared)
        }
      }
    }
  }
}

function compareRequestBody(
  baselineValue: JsonValue,
  currentValue: JsonValue,
  baselineDocument: JsonValue,
  currentDocument: JsonValue,
  location: string,
  failures: string[]
) {
  const baselineRequestBody = resolveReference(baselineDocument, baselineValue)
  const currentRequestBody = resolveReference(currentDocument, currentValue)
  if (!isRecord(baselineRequestBody) || !isRecord(currentRequestBody)) return
  const baselineContent = baselineRequestBody.content
  const currentContent = currentRequestBody.content
  if (baselineContent === undefined || currentContent === undefined || !isRecord(baselineContent) || !isRecord(currentContent)) return

  for (const [mediaType, baselineMediaValue] of Object.entries(baselineContent)) {
    const currentMediaValue = currentContent[mediaType]
    if (!isRecord(baselineMediaValue) || currentMediaValue === undefined || !isRecord(currentMediaValue)) continue
    const baselineSchema = baselineMediaValue.schema
    const currentSchema = currentMediaValue.schema
    if (baselineSchema === undefined || currentSchema === undefined) continue
    compareRequestSchema(baselineSchema, currentSchema, baselineDocument, currentDocument, `${location}.content.${mediaType}.schema`, failures, new WeakMap())
  }
}

function compareRequestBodies(
  baselineValue: JsonValue,
  currentValue: JsonValue,
  baselineDocument: JsonValue,
  currentDocument: JsonValue,
  location: string,
  failures: string[]
) {
  if (Array.isArray(baselineValue) && Array.isArray(currentValue)) {
    for (const [index, value] of baselineValue.entries()) {
      const currentChild = currentValue[index]
      if (currentChild !== undefined) {
        compareRequestBodies(value, currentChild, baselineDocument, currentDocument, `${location}[${index}]`, failures)
      }
    }
    return
  }
  if (!isRecord(baselineValue) || !isRecord(currentValue)) return
  for (const [key, value] of Object.entries(baselineValue)) {
    const currentChild = currentValue[key]
    if (currentChild === undefined) continue
    if (key === 'requestBody') {
      compareRequestBody(value, currentChild, baselineDocument, currentDocument, `${location}.${key}`, failures)
    } else {
      compareRequestBodies(value, currentChild, baselineDocument, currentDocument, `${location}.${key}`, failures)
    }
  }
}

export function compareOpenApiCompatibility(baseline: JsonValue, current: JsonValue): string[] {
  const failures: string[] = []
  compareCompatible(baseline, current, 'openapi', failures, current)
  compareRequestBodies(baseline, current, baseline, current, 'openapi', failures)
  return failures
}

async function main() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as JsonValue
  const current = openApiDocument as unknown as JsonValue
  const failures = compareOpenApiCompatibility(baseline, current)
  if (failures.length > 0) {
    throw new Error(`OpenAPI v1 is not backward compatible with its release baseline:\n- ${failures.join('\n- ')}`)
  }

  await mkdir(generatedDirectory, { recursive: true })
  await writeFile(generatedPath, `${JSON.stringify(openApiDocument, null, 2)}\n`)
  console.log(`OpenAPI v1 remains backward compatible; wrote ${path.relative(process.cwd(), generatedPath)}`)
}

if (import.meta.main) await main()
