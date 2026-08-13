import { readdir } from 'node:fs/promises'

export type ModuleConfig = Record<string, unknown>

export interface ModulePropDefinition extends Record<string, unknown> {
  type: string
  default?: unknown
}

export type ModulePropInput = string | ModulePropDefinition

export interface ParsedModuleProp extends Record<string, unknown> {
  default: unknown
  type: string
}

export interface ModuleDefinition extends Record<string, unknown> {
  key: string
  props: Record<string, ModulePropInput>
}

export interface LoadedModuleDefinition extends Record<string, unknown> {
  key: string
  props: Record<string, ParsedModuleProp>
}

export function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function hasMethod (value: unknown, method: string): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  return typeof (value as Record<string, unknown>)[method] === 'function'
}

export async function readModuleDirectories (directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}
export function readModuleDefinition (value: unknown, source: string): ModuleDefinition {
  if (!isRecord(value) || typeof value.key !== 'string' || !isRecord(value.props)) {
    throw new Error(`Invalid module definition: ${source}`)
  }
  for (const prop of Object.values(value.props)) {
    if (typeof prop !== 'string' && (!isRecord(prop) || typeof prop.type !== 'string')) {
      throw new Error(`Invalid module property definition: ${source}`)
    }
  }
  return value as ModuleDefinition
}

export function readYamlRecord (value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid YAML object: ${source}`)
  }
  return value
}

export function readString (record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

export function errorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isNodeError (err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
