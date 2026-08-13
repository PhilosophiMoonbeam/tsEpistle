declare module 'custom-error-instance' {
  export interface CustomErrorOptions {
    message?: string
    code?: string | number
    [key: string]: unknown
  }

  export interface CustomError extends Error {
    code?: string | number
    [key: string]: unknown
  }

  export type CustomErrorConstructor = new (message?: string | CustomErrorOptions, configuration?: unknown) => CustomError

  export default function createCustomError(name: string, properties?: CustomErrorOptions): CustomErrorConstructor
}
