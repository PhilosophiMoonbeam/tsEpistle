import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import type { Knex } from 'knex'
import type { NextFunction, Request, Response } from 'express'

export type { NextFunction, Request, Response }

export interface WikiAuth {
  checkAccess(user: Express.User | undefined, permissions: readonly string[]): boolean
  checkPageAccess(user: Express.User | undefined, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
  loadPageRuleAuthority(requester: Express.User | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  getEffectivePermissions(request: Request, context: AccessPage, authority: PageRuleAuthority): unknown
}

export interface OperationError extends Error {
  status?: number
  code?: unknown
}

export const objectValue = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

export const errorStatus = (value: unknown): number | undefined => {
  const status = objectValue(value, 'status')
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

export const operationError = (value: unknown): OperationError => {
  const error: OperationError = value instanceof Error ? value : new Error(String(value))
  const status = errorStatus(value)
  if (status !== undefined) error.status = status
  const code = objectValue(value, 'code')
  if (code !== undefined) error.code = code
  return error
}

let transportRuntime: unknown

export const configureTransportRuntime = <Runtime extends object>(runtime: Runtime): void => {
  transportRuntime = runtime
}

export const getTransportRuntime = <Runtime>(): Runtime => {
  if (typeof transportRuntime !== 'object' || transportRuntime === null) {
    throw new Error('HTTP transport runtime is unavailable')
  }
  return transportRuntime as Runtime
}

export const getWikiAuth = (): WikiAuth => getTransportRuntime<{ auth: WikiAuth }>().auth
