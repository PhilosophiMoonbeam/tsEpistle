import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { openApiDocument } from '../controllers/api-v1/openapi.ts'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const baselinePath = path.resolve('server/contracts/openapi-v1-baseline.json')
const generatedDirectory = path.resolve('node_modules/.cache/wiki')
const generatedPath = path.join(generatedDirectory, 'openapi-v1.json')
const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as JsonValue
const current = openApiDocument as unknown as JsonValue
const failures: string[] = []

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareArray(baselineValue: JsonValue[], currentValue: JsonValue[], location: string) {
  if (location.endsWith('.required') || location.endsWith('.enum') || location.endsWith('.type')) {
    for (const value of baselineValue) {
      if (!currentValue.some(candidate => isDeepStrictEqual(candidate, value))) {
        failures.push(`${location} no longer includes ${JSON.stringify(value)}`)
      }
    }
    return
  }
  for (const [index, value] of baselineValue.entries()) {
    if (currentValue[index] === undefined) {
      failures.push(`${location}[${index}] was removed`)
    } else {
      compareCompatible(value, currentValue[index], `${location}[${index}]`)
    }
  }
}

function compareConstraint(baselineValue: number, currentValue: number, location: string): boolean {
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

function compareCompatible(baselineValue: JsonValue, currentValue: JsonValue, location: string) {
  if (Array.isArray(baselineValue)) {
    if (!Array.isArray(currentValue)) {
      failures.push(`${location} changed from an array`)
      return
    }
    compareArray(baselineValue, currentValue, location)
    return
  }
  if (isRecord(baselineValue)) {
    if (!isRecord(currentValue)) {
      failures.push(`${location} changed from an object`)
      return
    }
    for (const [key, value] of Object.entries(baselineValue)) {
      if (!(key in currentValue)) {
        failures.push(`${location}.${key} was removed`)
      } else {
        compareCompatible(value, currentValue[key]!, `${location}.${key}`)
      }
    }
    return
  }
  if (typeof baselineValue === 'number' && typeof currentValue === 'number' && compareConstraint(baselineValue, currentValue, location)) {
    return
  }
  if (!isDeepStrictEqual(baselineValue, currentValue)) {
    failures.push(`${location} changed from ${JSON.stringify(baselineValue)} to ${JSON.stringify(currentValue)}`)
  }
}

compareCompatible(baseline, current, 'openapi')
if (failures.length > 0) {
  throw new Error(`OpenAPI v1 is not backward compatible with its release baseline:\n- ${failures.join('\n- ')}`)
}

await mkdir(generatedDirectory, { recursive: true })
await writeFile(generatedPath, `${JSON.stringify(openApiDocument, null, 2)}\n`)
console.log(`OpenAPI v1 remains backward compatible; wrote ${path.relative(process.cwd(), generatedPath)}`)
