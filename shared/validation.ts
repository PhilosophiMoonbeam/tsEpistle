import validator from 'validator'

type ConstraintMessage = string

type PresenceConstraint = {
  allowEmpty?: boolean
  message?: ConstraintMessage
}

type LengthConstraint = {
  minimum?: number
  maximum?: number
  tooShort?: ConstraintMessage
  tooLong?: ConstraintMessage
}

type EmailConstraint = boolean | {
  message?: ConstraintMessage
}

type EqualityConstraint = string | {
  attribute: string
  message?: ConstraintMessage
}

type UrlConstraint = {
  schemes?: string[]
  allowLocal?: boolean
  allowDataUrl?: boolean
  message?: ConstraintMessage
}

type FormatConstraint = {
  pattern: string
  flags?: string
  message?: ConstraintMessage
}

export type ValidationConstraints = {
  presence?: PresenceConstraint
  length?: LengthConstraint
  email?: EmailConstraint
  equality?: EqualityConstraint
  url?: UrlConstraint
  format?: FormatConstraint
}

export type ValidationSchema = Record<string, ValidationConstraints | undefined>
export type ValidationErrors = Record<string, string[]>

type FlatValidationOptions = {
  format: 'flat'
  fullMessages?: boolean
}

type AttributeValidationOptions = {
  format?: undefined
  fullMessages?: boolean
}

type ValidationOptions = FlatValidationOptions | AttributeValidationOptions

const fieldLabel = (field: string): string => field
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replaceAll('_', ' ')
  .replace(/^./, character => character.toUpperCase())

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === ''

const messageFor = (field: string, custom: string | undefined, fallback: string, fullMessages: boolean): string => {
  if (custom?.startsWith('^')) return custom.slice(1)
  if (!fullMessages) return custom ?? fallback
  return `${fieldLabel(field)} ${custom ?? fallback}`
}

function validateValues (
  values: Record<string, unknown>,
  schema: ValidationSchema,
  options: FlatValidationOptions
): string[] | undefined
function validateValues (
  values: Record<string, unknown>,
  schema: ValidationSchema,
  options?: AttributeValidationOptions
): ValidationErrors | undefined
function validateValues (
  values: Record<string, unknown>,
  schema: ValidationSchema,
  options: ValidationOptions = {}
): ValidationErrors | string[] | undefined {
  const errors: ValidationErrors = {}
  const fullMessages = options.fullMessages !== false

  const addError = (field: string, message: string): void => {
    const fieldErrors = errors[field] ?? []
    fieldErrors.push(message)
    errors[field] = fieldErrors
  }

  for (const [field, constraints] of Object.entries(schema)) {
    if (!constraints) continue
    const value = values[field]

    if (constraints.presence && constraints.presence.allowEmpty === false && isEmpty(value)) {
      addError(field, messageFor(field, constraints.presence.message, "can't be blank", fullMessages))
      continue
    }
    if (isEmpty(value)) continue

    const text = String(value)
    if (constraints.email && !validator.isEmail(text)) {
      const custom = typeof constraints.email === 'object' ? constraints.email.message : undefined
      addError(field, messageFor(field, custom, 'is not a valid email', fullMessages))
    }

    if (constraints.length?.minimum !== undefined && text.length < constraints.length.minimum) {
      addError(field, messageFor(
        field,
        constraints.length.tooShort,
        `is too short (minimum is ${constraints.length.minimum} characters)`,
        fullMessages
      ))
    }
    if (constraints.length?.maximum !== undefined && text.length > constraints.length.maximum) {
      addError(field, messageFor(
        field,
        constraints.length.tooLong,
        `is too long (maximum is ${constraints.length.maximum} characters)`,
        fullMessages
      ))
    }

    if (constraints.equality) {
      const equality = typeof constraints.equality === 'string'
        ? { attribute: constraints.equality }
        : constraints.equality
      if (value !== values[equality.attribute]) {
        addError(field, messageFor(
          field,
          equality.message,
          `is not equal to ${fieldLabel(equality.attribute)}`,
          fullMessages
        ))
      }
    }

    if (constraints.url && !validator.isURL(text, {
      protocols: constraints.url.schemes ?? ['http', 'https', 'ftp'],
      require_protocol: true,
      require_tld: constraints.url.allowLocal !== true,
      allow_protocol_relative_urls: false
    })) {
      addError(field, messageFor(field, constraints.url.message, 'is not a valid url', fullMessages))
    } else if (constraints.url?.allowDataUrl === false && text.toLowerCase().startsWith('data:')) {
      addError(field, messageFor(field, constraints.url.message, 'is not a valid url', fullMessages))
    }

    if (constraints.format && !new RegExp(constraints.format.pattern, constraints.format.flags).test(text)) {
      addError(field, messageFor(field, constraints.format.message, 'is invalid', fullMessages))
    }
  }

  if (Object.keys(errors).length === 0) return undefined
  return options.format === 'flat' ? Object.values(errors).flat() : errors
}

export default validateValues
