import { describe, expect, it } from '../bun-test.mts'
import { buildSchema, parse, validate } from 'graphql'
import { GRAPHQL_STARTERS } from '../../core/graphql-explorer.ts'
import fs from 'node:fs'
import path from 'node:path'

describe('GraphQL administration workspace', () => {
  it('validates every starter against the actual schema documents', () => {
    const root = path.join(process.cwd(), 'server/graph/schemas')
    const schema = buildSchema(
      'directive @rateLimit(limit: Int, duration: Int) on FIELD_DEFINITION\n' +
        fs
          .readdirSync(root)
          .filter(name => name.endsWith('.graphql'))
          .map(name => fs.readFileSync(path.join(root, name), 'utf8'))
          .join('\n')
    )
    for (const starter of Object.values(GRAPHQL_STARTERS)) {
      const document = parse(starter.query)
      expect(validate(schema, document).map(error => error.message)).toEqual([])
      expect(document.definitions.every(node => node.kind === 'OperationDefinition' && node.operation === 'query')).toBe(true)
    }
  })
})
