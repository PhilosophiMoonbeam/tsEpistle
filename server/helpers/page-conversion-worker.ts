import { z } from 'zod'
import { convertHtmlCandidate } from './page-conversion-engine.ts'
import { PAGE_CONVERSION_LIMITS as limits } from './page-conversion-protocol.ts'

const Input = z.object({
  source: z.string().max(limits.inputBytes),
  page: z.object({ path: z.string().max(4096), localeCode: z.string().max(64) }).strict(),
  config: z.record(z.string(), z.unknown()),
  children: z.array(z.object({ key: z.string().regex(/^markdown[A-Za-z]+$/), config: z.record(z.string(), z.unknown()) }).strict()).max(32),
  namespaced: z.boolean()
}).strict()

try {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength
    if (bytes > limits.inputBytes + 64 * 1024) throw new Error('input budget')
    chunks.push(chunk)
  }
  const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  // Only the pure renderer's locale context is available; no database, session or credentials.
  Reflect.set(globalThis, 'WIKI', { config: { lang: { namespacing: input.namespaced } } })
  const result = JSON.stringify(await convertHtmlCandidate(input))
  if (Buffer.byteLength(result, 'utf8') > limits.wireBytes) throw new Error('wire budget')
  await Bun.write(Bun.stdout, result)
} catch {
  // Do not send parser diagnostics or source text to shared server logs.
  process.exitCode = 1
}
