import type { NextFunction, Request, Response } from 'express'

export type { NextFunction, Request, Response }

export interface WikiAuth {
  checkAccess(user: Express.User | undefined, permissions: readonly string[], context?: unknown): boolean
  getEffectivePermissions(request: Request, context: unknown): unknown
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

export const getWikiAuth = (): WikiAuth => WIKI.auth as WikiAuth
