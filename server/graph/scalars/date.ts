import { GraphQLScalarType, Kind } from 'graphql'

const dateScalar = new GraphQLScalarType<Date, string>({
  name: 'Date',
  description: 'ISO date-time string at UTC',
  parseValue (value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError('Date value must be a string or number!')
    }
    return new Date(value)
  },
  serialize (value: unknown) {
    if (!(value instanceof Date)) {
      throw new TypeError('Date value must be a Date!')
    }
    return value.toISOString()
  },
  parseLiteral (ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError('Date value must be an string!')
    }
    return new Date(ast.value)
  }
})

export default { Date: dateScalar }
