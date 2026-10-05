import { Ajv, type Options, type ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ExternalMcpSchemaRequest, ExternalMcpSchemaResponse } from './external-mcp-schema-validator.ts'

const options: Options = {
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  addUsedSchema: false,
  logger: false
}
interface CompiledSchema {
  readonly source: string
  readonly validate: ValidateFunction
}
let validators = new Map<string, CompiledSchema>()

process.on('message', (request: ExternalMcpSchemaRequest) => {
  let result: boolean | null = null
  try {
    if (request.operation === 'catalog') {
      const current = new Map<string, CompiledSchema>()
      let modern: Ajv2020 | undefined
      let draft2019: Ajv2019 | undefined
      let draft7: Ajv | undefined
      for (const { name, schema } of request.schemas) {
        const source = JSON.stringify(schema)
        const cached = validators.get(name)
        if (cached?.source === source) {
          current.set(name, cached)
          continue
        }
        if (schema.$async) throw new Error('Unsupported asynchronous schema')
        const compiler =
          schema.$schema === 'http://json-schema.org/draft-07/schema#'
            ? (draft7 ??= new Ajv(options))
            : schema.$schema === 'https://json-schema.org/draft/2019-09/schema'
              ? (draft2019 ??= new Ajv2019(options))
              : (modern ??= new Ajv2020(options))
        // Synchronous compile never downloads an unresolved $ref. Ajv owns safe
        // schema code generation; the endpoint never supplies executable source.
        const validate = compiler.compile(schema)
        if (Reflect.get(validate, '$async')) throw new Error('Unsupported asynchronous validator')
        current.set(name, { source, validate })
      }
      validators = current
      result = true
    } else {
      const validate = validators.get(request.name)?.validate
      if (!validate) throw new Error('Unknown tool schema')
      result = validate(request.input)
    }
  } catch {
    // No remote schema, regex, reference URL, or raw dependency error crosses IPC.
    result = null
  }
  const response: ExternalMcpSchemaResponse = { id: request.id, result }
  process.send?.(response)
})
process.once('disconnect', () => {
  process.exit(0)
})
process.send?.('ready')
