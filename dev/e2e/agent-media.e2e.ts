import { expect, type Locator, type Page } from '@playwright/test'
import type { AgentMediaView, AgentThreadState } from '../../shared/agents/contracts.ts'
import { installEnabledAgentFixture } from './agent-fixture.ts'
import { expectLocatorWithinViewport, openSearch, responsiveTest as test } from './helpers.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const generatedId = '00000000-0000-4000-8000-000000000701'
const generated: AgentMediaView = { id: generatedId, kind: 'generated-image', filename: 'generated-image.png', mimeType: 'image/png', byteLength: png.length, available: true }

async function installBrowserIdentity(page: Page) {
  await page.route('**/_api/users/whoami', route => route.fulfill({ json: { authenticated: true, user: { id: 900001, name: 'Media fixture', email: 'media-fixture@example.invalid', permissions: ['use:agents'], localeCode: 'en' } } }))
}
async function openAgent(page: Page): Promise<Locator> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.nav-header')).toBeVisible()
  const search = await openSearch(page)
  await search.fill('home')
  const dialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Ask about this', exact: true }).click()
  const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
  await expect(agent).toBeVisible()
  await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
  return agent
}
async function installRecorder(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__agentMediaStopped', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { Reflect.set(window, '__agentMediaStopped', Number(Reflect.get(window, '__agentMediaStopped')) + 1) } }] }) } })
    class FixtureRecorder {
      static isTypeSupported() { return true }
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded voice'], { type: 'audio/webm' }) }); this.onstop?.() }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FixtureRecorder })
  })
}

test('Agent media stays hidden without administrator configuration', async ({ page }) => {
  await installBrowserIdentity(page)
  const fixture = await installEnabledAgentFixture(page)
  const agent = await openAgent(page)
  await expect(agent.getByRole('button', { name: 'Attach images or PDFs', exact: true })).toHaveCount(0)
  await expect(agent.getByRole('button', { name: 'Generate or edit an image', exact: true })).toHaveCount(0)
  await expect(agent.getByRole('button', { name: 'Dictate a message', exact: true })).toHaveCount(0)
  const screenshot = test.info().outputPath('agent-media-final-layout.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('agent-media-final-layout', { path: screenshot, contentType: 'image/png' })
  fixture.assertNoUnexpectedRequests()
})

test('Agent media uploads, generates, edits, and transcribes within the existing composer', async ({ page }) => {
  await installBrowserIdentity(page)
  await installRecorder(page)
  const fixture = await installEnabledAgentFixture(page, { media: { attachments: true, imageGeneration: true, transcription: true } })
  const uploaded: AgentMediaView[] = []
  const removed: string[] = []
  const sent: Array<{ content: string; attachmentIds: string[]; responseMode: string }> = []
  let thread: AgentThreadState | null = null
  let uploadIndex = 0
  let speechRunId = ''
  await page.route(/\/_api\/agents(?:\/|$)/, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith(`/sessions/${fixture.sessionId}/media`) && request.method() === 'POST') {
      expect(request.headers()['x-wiki-csrf']).toBeTruthy()
      expect(request.headers()['content-type']).toContain('multipart/form-data; boundary=')
      const body = request.postDataBuffer()?.toString() ?? ''
      const mimeType = body.includes('application/pdf') ? 'application/pdf' : body.includes('audio/webm') ? 'audio/webm' : 'image/png'
      const media: AgentMediaView = { id: `00000000-0000-4000-8000-${String(800 + ++uploadIndex).padStart(12, '0')}`, kind: 'attachment', filename: mimeType === 'application/pdf' ? 'reference.pdf' : mimeType === 'audio/webm' ? 'dictation.webm' : 'reference.png', mimeType, byteLength: png.length, available: true }
      uploaded.push(media)
      return route.fulfill({ status: 201, json: { media } })
    }
    if (/\/media\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: png })
    if (/\/media\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      removed.push(path.split('/').at(-1)!)
      return route.fulfill({ status: 204 })
    }
    if (thread && path === `/_api/agents/sessions/${fixture.sessionId}` && request.method() === 'GET') return route.fulfill({ json: thread })
    if (thread && path.endsWith(`/sessions/${fixture.sessionId}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON() as { content: string; attachmentIds: string[]; responseMode: string }
      sent.push(body)
      const now = new Date().toISOString()
      const run = { id: crypto.randomUUID(), sessionId: fixture.sessionId, status: 'succeeded' as const, attempt: 1, eventSequence: 2, canCancel: false, createdAt: now, startedAt: now, completedAt: now, errorCode: null, errorMessage: null }
      thread = { ...thread, session: { ...thread.session, version: thread.session.version + 1, currentRun: run }, messages: [
        ...thread.messages,
        { id: crypto.randomUUID(), runId: run.id, ordinal: thread.messages.length, role: 'user', status: 'complete', content: body.content, citations: [], createdAt: now, updatedAt: now, media: uploaded.filter(media => body.attachmentIds.includes(media.id)) },
        { id: crypto.randomUUID(), runId: run.id, ordinal: thread.messages.length + 1, role: 'assistant', status: 'complete', content: '', citations: [], createdAt: now, updatedAt: now, media: [generated] }
      ] }
      return route.fulfill({ status: 202, json: { run, replayed: false } })
    }
    if (thread && path.endsWith('/transcriptions') && request.method() === 'POST') {
      const body = request.postDataJSON() as { attachmentId: string; expectedSessionVersion: number }
      expect(uploaded.find(media => media.id === body.attachmentId)?.mimeType).toBe('audio/webm')
      expect(body.expectedSessionVersion).toBe(thread.session.version)
      speechRunId = crypto.randomUUID()
      thread = { ...thread, session: { ...thread.session, version: thread.session.version + 1 } }
      return route.fulfill({ status: 202, json: { runId: speechRunId } })
    }
    if (path === `/_api/agents/runs/${speechRunId}/transcription`) return route.fulfill({ json: { status: 'succeeded', text: 'Make the background green.' } })
    return route.fallback()
  })
  const initialThread = page.waitForResponse(response => {
    const path = new URL(response.url()).pathname
    return (path === `/_api/agents/sessions/${fixture.sessionId}` && response.request().method() === 'GET') || (path === '/_api/agents/sessions' && response.request().method() === 'POST')
  })
  const agent = await openAgent(page)
  thread = await (await initialThread).json() as AgentThreadState
  const input = agent.locator('.agent-composer textarea')
  const fileInput = agent.locator('input[type=file]')
  const attach = agent.getByRole('button', { name: 'Attach images or PDFs', exact: true })
  await expectLocatorWithinViewport(attach, 'Agent attachment control')
  await fileInput.setInputFiles({ name: 'reference.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nfixture') })
  await expect(agent.getByRole('button', { name: 'Remove reference.pdf', exact: true })).toBeVisible()
  await agent.getByRole('button', { name: 'Remove reference.pdf', exact: true }).click()
  await expect.poll(() => removed.length).toBe(1)
  await expect(agent.getByRole('button', { name: 'Remove reference.pdf', exact: true })).toHaveCount(0)
  await expect(attach).toBeEnabled()
  await fileInput.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png })
  await expect(agent.getByRole('button', { name: 'Remove reference.png', exact: true })).toBeVisible()
  await input.fill('Turn this into a watercolor illustration.')
  await agent.getByRole('button', { name: 'Generate or edit an image', exact: true }).click()
  await agent.getByRole('button', { name: 'Create image', exact: true }).click()
  await expect(agent.locator('.agent-message__media img[alt="Image created by Wiki Agent"]')).toBeVisible()
  await expect(agent.getByRole('link', { name: 'generated-image.png · Download', exact: true })).toBeVisible()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.responseMode).toBe('image')
  expect(sent[0]?.attachmentIds).toEqual([uploaded[1]?.id])
  await agent.getByRole('button', { name: 'Edit image', exact: true }).click()
  await expect(agent.getByRole('button', { name: 'Generate or edit an image', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(agent.getByRole('button', { name: 'Remove reference.png', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Edit this image: ')
  expect(uploaded).toHaveLength(3)
  expect(uploaded[2]?.id).not.toBe(generatedId)
  expect(sent).toHaveLength(1)
  await input.fill('Keep my draft.')
  await agent.getByRole('button', { name: 'Dictate a message', exact: true }).click()
  await expect(agent.getByText('Recording ·', { exact: false })).toBeVisible()
  await agent.getByRole('button', { name: 'Transcribe', exact: true }).click()
  await expect(input).toHaveValue('Keep my draft. Make the background green.')
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__agentMediaStopped'))).toBe(1)
  expect(sent).toHaveLength(1)
  const screenshot = test.info().outputPath('agent-media-final-layout.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('agent-media-final-layout', { path: screenshot, contentType: 'image/png' })
  fixture.assertNoUnexpectedRequests()
})
