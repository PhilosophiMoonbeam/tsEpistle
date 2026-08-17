import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import express from 'express'
import { z } from 'zod'
import { IsolatedBrowserWorker } from './runtime.ts'
import { BrowserWorkerError } from './errors.ts'
import { BrowserEnvelopeVerifier, BrowserProtocolError } from './protocol.ts'
const EnvSchema = z.object({
  AGENT_BROWSER_TLS_CERT: z.string().min(1),
  AGENT_BROWSER_TLS_KEY: z.string().min(1),
  AGENT_BROWSER_TLS_CA: z.string().min(1),
  AGENT_BROWSER_SIGNING_KEYS: z.string().min(1),
  AGENT_BROWSER_PORT: z.coerce.number().int().min(1).max(65_535).default(9443),
  AGENT_BROWSER_MAX_CONTEXTS: z.coerce.number().int().min(1).max(64).default(8),
  AGENT_BROWSER_CHROMIUM_PATH: z.string().min(1).optional()
})
const keysSchema = z.record(z.string().min(1).max(64), z.string().min(44).max(128))

export const createBrowserWorkerApp = (verifier: BrowserEnvelopeVerifier, worker: IsolatedBrowserWorker): express.Express => {
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }))
  app.post('/v1/actions', express.json({ limit: '128kb', strict: true, type: 'application/json' }), async (req, res) => {
    try {
      const envelope = verifier.verify(req.body)
      const result = await worker.execute({ contextId: envelope.contextId, actionCallId: envelope.actionCallId, sequence: envelope.sequence, action: envelope.action, limits: envelope.limits })
      if (result.kind === 'screenshot') return res.status(200).json({ ...result, bytes: result.bytes.toString('base64') })
      return res.status(200).json(result)
    } catch (error) {
      if (error instanceof BrowserProtocolError || error instanceof BrowserWorkerError) return res.status(error.status).json({ error: error.code, message: error.message })
      if (error instanceof z.ZodError) return res.status(400).json({ error: 'INVALID_BROWSER_REQUEST', message: 'Browser request validation failed' })
      return res.status(500).json({ error: 'BROWSER_WORKER_FAILURE', message: 'Browser worker failed' })
    }
  })
  return app
}

const start = async (): Promise<void> => {
  const env = EnvSchema.parse(process.env)
  const encodedKeys = keysSchema.parse(JSON.parse(env.AGENT_BROWSER_SIGNING_KEYS))
  const verifier = new BrowserEnvelopeVerifier(new Map(Object.entries(encodedKeys).map(([id, value]) => [id, Buffer.from(value, 'base64')])))
  const worker = new IsolatedBrowserWorker({ ...(env.AGENT_BROWSER_CHROMIUM_PATH ? { executablePath: env.AGENT_BROWSER_CHROMIUM_PATH } : {}), maximumContexts: env.AGENT_BROWSER_MAX_CONTEXTS })
  const server = createServer({ cert: readFileSync(env.AGENT_BROWSER_TLS_CERT), key: readFileSync(env.AGENT_BROWSER_TLS_KEY), ca: readFileSync(env.AGENT_BROWSER_TLS_CA), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, createBrowserWorkerApp(verifier, worker))
  const shutdown = async (): Promise<void> => { server.close(); await worker.shutdown() }
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  server.listen(env.AGENT_BROWSER_PORT, '0.0.0.0')
}

if (process.argv[1]?.endsWith('/browser/worker.ts') || process.argv[1]?.endsWith('/browser/worker.js')) void start()
