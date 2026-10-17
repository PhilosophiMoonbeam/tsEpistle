import { createServer } from 'node:http'
import express from 'express'
import multer from 'multer'
import { expect, type Locator, type Page, type Request } from '@playwright/test'
import type { AgentMediaView, AgentThreadState } from '../../shared/agents/contracts.ts'
import { installEnabledAgentFixture, renewFixtureThreadResolution } from './agent-fixture.ts'
import { authenticateAsAdmin, expectLocatorWithinViewport, responsiveTest as test } from './helpers.ts'

// Route-backed Agent fixtures own these responses; real service-worker coverage lives in offline.e2e.ts.
test.use({ serviceWorkers: 'block' })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==', 'base64')
const generatedId = '00000000-0000-4000-8000-000000000701'
const generated: AgentMediaView = {
  id: generatedId,
  kind: 'generated-image',
  filename: 'generated-image.png',
  mimeType: 'image/png',
  byteLength: png.length,
  available: true
}

async function openAgent(page: Page, waitForComposer = true): Promise<Locator> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.nav-header')).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('ControlOrMeta+Shift+A')
  const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
  await expect(agent).toBeVisible()
  if (waitForComposer) await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
  return agent
}
async function installRecorder(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__agentMediaStopped', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                Reflect.set(window, '__agentMediaStopped', Number(Reflect.get(window, '__agentMediaStopped')) + 1)
              }
            }
          ]
        })
      }
    })
    class FixtureRecorder {
      static isTypeSupported() {
        return true
      }
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['recorded voice'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FixtureRecorder })
  })
}

// Read the browser's upload at the HTTP boundary: Firefox can omit file-backed
// multipart bodies from Playwright's intercepted Request.postDataBuffer().
const mediaTest = test.extend<{ mediaUploads: { url: string; media: AgentMediaView[] } }>({
  mediaUploads: async ({ baseURL }, use) => {
    const media: AgentMediaView[] = []
    const errors: unknown[] = []
    if (!baseURL) throw new Error('The media upload fixture requires the configured application origin.')
    const origin = new URL(baseURL).origin
    // Bun 1.4.2's formData() retypes audio/webm parts as video/webm.
    const parse = multer({ storage: multer.memoryStorage(), limits: { files: 1, fields: 0, fileSize: 250_000_000 } }).single('file')
    const app = express()
    app.use((request, response, next) => {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('access-control-allow-credentials', 'true')
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'POST')
        response.setHeader('access-control-allow-headers', 'content-type, x-wiki-csrf')
        response.status(204).end()
        return
      }
      next()
    })
    app.post('/media', async (request, response) => {
      try {
        expect(request.headers['x-wiki-csrf']).toBeTruthy()
        expect(request.headers['content-type']).toContain('multipart/form-data; boundary=')
        await new Promise<void>((resolve, reject) => {
          parse(request, response, error => error ? reject(error) : resolve())
        })
        const file = request.file
        if (!file) throw new Error('The media upload must contain a file.')
        const uploaded: AgentMediaView = {
          id: `00000000-0000-4000-8000-${String(801 + media.length).padStart(12, '0')}`,
          kind: 'attachment',
          filename: file.originalname,
          mimeType: file.mimetype,
          byteLength: file.size,
          available: true
        }
        media.push(uploaded)
        response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ media: uploaded }))
      } catch (error) {
        errors.push(error)
        response.writeHead(500).end()
      }
    })
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The media upload fixture must listen on a TCP port.')
    try {
      await use({ url: `http://127.0.0.1:${address.port}/media`, media })
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    if (errors.length) throw errors[0]
  }
})

test('Agent media stays hidden without administrator configuration', async ({ page }) => {
  await authenticateAsAdmin(page)
  const fixture = await installEnabledAgentFixture(page)
  let releaseThread!: () => void
  const threadResponse = new Promise<void>(resolve => { releaseThread = resolve })
  const isInitialThreadRequest = (request: Request) => {
    const path = new URL(request.url()).pathname
    return (
      (path === `/_api/agents/sessions/${fixture.sessionId}` && request.method() === 'GET') ||
      (path === '/_api/agents/sessions' && request.method() === 'POST')
    )
  }
  await page.route(/\/_api\/agents(?:\/|$)/, async route => {
    if (isInitialThreadRequest(route.request())) await threadResponse
    await route.fallback()
  })
  const initialThread = page.waitForRequest(isInitialThreadRequest)
  const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
  const contextRow = agent.locator('.agent-composer__context-row')
  try {
    // Delay only the HTTP response: the real parent renders its opening composer.
    await openAgent(page, false)
    await initialThread
    await expect(agent.locator('.inline-agent__loading')).toBeVisible()
    await expect(agent.locator('.agent-composer__editor')).toBeVisible()
    await expect(contextRow).toHaveCount(1)
    await expect(contextRow.locator('.agent-context, .agent-composer__goal-chip')).toHaveCount(0)
    await expect.poll(() => contextRow.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height, layoutBoxes: element.getClientRects().length }
    }), 'An empty context row must reserve no layout space while opening a conversation').toEqual({ width: 0, height: 0, layoutBoxes: 0 })
  } finally {
    releaseThread()
  }
  await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
  await expect(contextRow).toBeVisible()
  await expect.poll(() => contextRow.evaluate(element => element.getBoundingClientRect().height),
    'Populated context must retain visible layout space after the conversation opens').toBeGreaterThan(0)
  const scopeControl = contextRow.getByRole('button', { name: 'Choose Agent search scope', exact: true })
  await expect(scopeControl).toBeVisible()
  await expectLocatorWithinViewport(scopeControl, 'Agent context search scope')
  await expect(agent.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0)
  await expect(agent.getByRole('button', { name: 'Choose creation tools', exact: true })).toHaveCount(0)
  await expect(agent.getByRole('button', { name: 'Start dictation', exact: true })).toHaveCount(0)
  const screenshot = test.info().outputPath('agent-media-final-layout.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('agent-media-final-layout', { path: screenshot, contentType: 'image/png' })
  fixture.assertNoUnexpectedRequests()
})

mediaTest('Agent media uploads, generates, edits, and transcribes within the existing composer', async ({ page, mediaUploads }) => {
  test.setTimeout(60_000)
  // Keep the browser actor and native auth/key handshakes consistent with the server.
  await authenticateAsAdmin(page)
  await installRecorder(page)
  const fixture = await installEnabledAgentFixture(page, { media: { attachments: true, imageGeneration: true, transcription: true } })
  const uploaded = mediaUploads.media
  const removed: string[] = []
  const sent: Array<{ content: string; attachmentIds: string[]; generationTools: string[]; responseMode?: string }> = []
  let thread: AgentThreadState | null = null
  let speechRunId = ''
  await page.route(/\/_api\/agents(?:\/|$)/, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith(`/sessions/${fixture.sessionId}/media`) && request.method() === 'POST') {
      expect(request.headers()['x-wiki-csrf']).toBeTruthy()
      expect(request.headers()['content-type']).toContain('multipart/form-data; boundary=')
      // Continue without overriding postData so the native file stream reaches
      // the fixture server even when interception exposes no multipart bytes.
      return route.continue({ url: mediaUploads.url })
    }
    if (/\/media\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: png })
    if (/\/media\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      removed.push(path.split('/').at(-1)!)
      return route.fulfill({ status: 204 })
    }
    if (thread && path === `/_api/agents/sessions/${fixture.sessionId}` && request.method() === 'GET') {
      thread = renewFixtureThreadResolution(thread)
      return route.fulfill({ json: thread })
    }
    if (thread && path.endsWith(`/sessions/${fixture.sessionId}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON() as { content: string; attachmentIds: string[]; generationTools: string[]; responseMode?: string }
      sent.push(body)
      const now = new Date().toISOString()
      const run = {
        id: crypto.randomUUID(),
        sessionId: fixture.sessionId,
        status: 'succeeded' as const,
        attempt: 1,
        eventSequence: 2,
        canCancel: false,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        errorCode: null,
        errorMessage: null
      }
      thread = {
        ...thread,
        session: { ...thread.session, version: thread.session.version + 1, currentRun: run },
        messages: [
          ...thread.messages,
          {
            id: crypto.randomUUID(),
            runId: run.id,
            ordinal: thread.messages.length,
            role: 'user',
            status: 'complete',
            content: body.content,
            citations: [],
            createdAt: now,
            updatedAt: now,
            media: uploaded.filter(media => body.attachmentIds.includes(media.id))
          },
          {
            id: crypto.randomUUID(),
            runId: run.id,
            ordinal: thread.messages.length + 1,
            role: 'assistant',
            status: 'complete',
            content: '',
            citations: [],
            createdAt: now,
            updatedAt: now,
            media: [generated]
          }
        ]
      }
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
    return (
      (path === `/_api/agents/sessions/${fixture.sessionId}` && response.request().method() === 'GET') ||
      (path === '/_api/agents/sessions' && response.request().method() === 'POST')
    )
  })
  const agent = await openAgent(page)
  thread = (await (await initialThread).json()) as AgentThreadState
  const input = agent.locator('.agent-composer textarea')
  const fileInput = agent.locator('input[type=file]')
  const attach = agent.getByRole('button', { name: 'Attach files', exact: true })
  await expectLocatorWithinViewport(attach, 'Agent attachment control')
  await fileInput.setInputFiles({
    name: 'reference.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(11 * 1024 * 1024)])
  })
  await expect(agent.getByRole('button', { name: 'Remove reference.pdf', exact: true })).toBeVisible()
  expect(uploaded[0]).toMatchObject({ filename: 'reference.pdf', mimeType: 'application/pdf', byteLength: 11 * 1024 * 1024 + 9 })
  await agent.getByRole('button', { name: 'Remove reference.pdf', exact: true }).click()
  await expect.poll(() => removed.length).toBe(1)
  await expect(agent.getByRole('button', { name: 'Remove reference.pdf', exact: true })).toHaveCount(0)
  await expect(attach).toBeEnabled()
  await fileInput.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png })
  await expect(agent.getByRole('button', { name: 'Remove reference.png', exact: true })).toBeVisible()
  expect(uploaded[1]).toMatchObject({ filename: 'reference.png', mimeType: 'image/png', byteLength: png.length })
  await input.fill('Turn this into a watercolor illustration.')
  await agent.getByRole('button', { name: 'Send', exact: true }).click()
  const generatedImage = agent.locator('.agent-message__media img[alt="Image created by Wiki Agent"]')
  await expect(generatedImage).toBeVisible()
  await expect.poll(() => generatedImage.evaluate(element => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  }), 'The generated image must decode in the browser').toBe(true)
  await expect(agent.getByRole('link', { name: 'generated-image.png · Download', exact: true })).toBeVisible()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.generationTools).toEqual(['image'])
  expect(sent[0]?.responseMode).toBeUndefined()
  expect(sent[0]?.attachmentIds).toEqual([uploaded[1]?.id])
  const editImage = agent.getByRole('button', { name: 'Edit image', exact: true })
  if (!await editImage.evaluate(button => {
    const bounds = button.getBoundingClientRect()
    const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return target !== null && button.contains(target)
  })) {
    // Read older output through the transcript instead of clicking through fixed chrome.
    await agent.getByRole('region', { name: 'Conversation transcript', exact: true }).focus()
    for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowUp')
  }
  await editImage.click()
  await expect(agent.getByRole('button', { name: 'Remove generated-image.png', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Edit this image: ')
  expect(uploaded).toHaveLength(3)
  expect(uploaded[2]?.id).not.toBe(generatedId)
  expect(sent).toHaveLength(1)
  await input.fill('Keep my draft.')
  await agent.getByRole('button', { name: 'Start dictation', exact: true }).click()
  await expect(agent.getByRole('status').filter({ hasText: 'Recording. Listening for speech.' })).toBeVisible()
  await agent.getByRole('button', { name: 'Stop dictation and review the transcript', exact: true }).click()
  await expect(input).toHaveValue('Keep my draft. Make the background green.')
  await expect(input).toBeEnabled()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__agentMediaStopped'))).toBe(1)
  expect(sent).toHaveLength(1)
  const screenshot = test.info().outputPath('agent-media-final-layout.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('agent-media-final-layout', { path: screenshot, contentType: 'image/png' })
  fixture.assertNoUnexpectedRequests()
})

test('Agent attaches a Wiki asset through a keyboard-accessible private-copy picker', async ({ page }) => {
  await authenticateAsAdmin(page)
  const fixture = await installEnabledAgentFixture(page, { media: { attachments: true, imageGeneration: true, transcription: false } })
  let assetCopies = 0
  let denyAssets = false
  const asset = { id: 42, filename: 'team-diagram.png', ext: '.png', fileSize: png.length, kind: 'image', createdAt: '2026-09-18T00:00:00Z' }
  await page.route('**/_api/assets?*', route =>
    denyAssets
      ? route.fulfill({ status: 403, json: { error: 'Restricted folder' } })
      : route.fulfill({
          json:
            new URL(route.request().url()).searchParams.get('folderId') === '7'
              ? [asset, { ...asset, id: 43, filename: 'handbook.pdf', ext: '.pdf', kind: 'binary' }]
              : []
        })
  )
  await page.route('**/_api/assets/folders?*', route =>
    route.fulfill({ json: new URL(route.request().url()).searchParams.get('parentFolderId') === '0' ? [{ id: 7, name: 'Team', slug: 'team' }] : [] })
  )
  await page.route(`**/_api/agents/sessions/${fixture.sessionId}/media/assets`, async route => {
    expect(route.request().postDataJSON()).toEqual({ assetId: 42 })
    expect(route.request().headers()['x-wiki-csrf']).toBeTruthy()
    assetCopies++
    await route.fulfill({
      status: 201,
      json: { media: { ...generated, id: '00000000-0000-4000-8000-000000000811', kind: 'attachment', filename: asset.filename } }
    })
  })
  await page.route('**/_api/agents/media/*/content', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.route('**/_api/agents/media/00000000-0000-4000-8000-000000000811', route => route.fulfill({ status: 204 }))
  const agent = await openAgent(page)
  const attach = agent.getByRole('button', { name: 'Attach files', exact: true })
  await attach.focus()
  await attach.press('Enter')
  await expect(page.getByText('Upload files', { exact: true })).toBeVisible()
  const browse = page.getByText('Browse Wiki assets', { exact: true })
  await browse.click()
  let picker = page.getByRole('dialog', { name: 'Browse Wiki assets', exact: true })
  await expectLocatorWithinViewport(picker.locator('.agent-asset-picker'), 'Wiki asset picker')
  await expect(picker.getByText('A private copy stays with this conversation.', { exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'Team', exact: true }).click()
  await picker.getByRole('searchbox', { name: 'Search filenames in this folder', exact: true }).fill('team-diagram')
  await expect(picker.getByRole('button', { name: 'Attach handbook.pdf', exact: true })).toHaveCount(0)
  await picker.getByRole('button', { name: 'Attach team-diagram.png', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(agent.getByRole('button', { name: 'Remove team-diagram.png', exact: true })).toBeVisible()
  expect(assetCopies).toBe(1)
  await expect(attach).toBeFocused()
  await attach.click()
  await page.getByText('Browse Wiki assets', { exact: true }).click()
  picker = page.getByRole('dialog', { name: 'Browse Wiki assets', exact: true })
  await expect(picker).toBeVisible()
  await picker.getByRole('searchbox').press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(agent).toBeVisible()
  expect(assetCopies).toBe(1)
  denyAssets = true
  await attach.click()
  await page.getByText('Browse Wiki assets', { exact: true }).click()
  picker = page.getByRole('dialog', { name: 'Browse Wiki assets', exact: true })
  await expect(picker.getByText('You don’t have access to browse Wiki assets. You can upload a file instead.', { exact: true })).toBeVisible()
  await expect(picker.getByText('Restricted folder', { exact: true })).toHaveCount(0)
  denyAssets = false
  await picker.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Team', exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'Team', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Attach team-diagram.png', exact: true })).toBeVisible()
  const screenshot = test.info().outputPath('agent-wiki-asset-picker.png')
  await picker.locator('.agent-asset-picker').screenshot({ path: screenshot })
  await test.info().attach('agent-wiki-asset-picker', { path: screenshot, contentType: 'image/png' })
  await picker.getByRole('button', { name: 'Close asset picker', exact: true }).click()
  fixture.assertNoUnexpectedRequests()
})

test('Agent combines selected creation tools in a normal conversation', async ({ page }) => {
  test.setTimeout(60_000)
  await authenticateAsAdmin(page)
  const fixture = await installEnabledAgentFixture(page, {
    media: { attachments: false, imageGeneration: false, videoGeneration: true, musicGeneration: true, transcription: false }
  })
  // One-second silent fixtures exercise native decoding without paid provider requests.
  const videoBytes = Buffer.from(
    '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',
    'base64'
  )
  const musicBytes = Buffer.from(
    'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAApAAAE5QAqKjAwNTU1Ojo/Pz9FRUpKSk9PVVVaWlpgYGVlZWpqb29vdXV6enp/f4WFioqKkJCVlZWamp+fn6WlqqqwsLC1tbq6usDAxcXFysrPz8/V1dra4ODg5eXq6urw8PX19fr6//8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJAPeAAAAAAAABOXVLMe7AAAAAAAAAAAAAAAAAP/zEMQAAAADSAAAAABMQU1FMy4xMExBTUUz//MSxA0AAANIAAAAAC4xMDEgKGJlTEFNRTMu//MQxBsAAANIAAAAADEwMSAoYmVMQU1FMy7/8xDEKAAAA0gAAAAAMTAxIChiZUxBTUUzLv/zEMQ1AAADSAAAAAAxMDEgKGJlTEFNRTMu//MQxEIAAANIAAAAADEwMSAoYmVMQU1FMy7/8xDETwAAA0gAAAAAMTAxIChiZXRMQU1FM//zEMRcAAADSAAAAAAuMTAxIChiZUxBTUUz//MQxGkAAANIAAAAAC4xMDEgKGJlTEFNRTP/8xLEdgAAA0gAAAAALjEwMSAoYmVMQU1FMy7/8xDEhAAAA0gAAAAAMTAxIChiZUxBTUUzLv/zEMSRAAADSAAAAAAxMDEgKGJlTEFNRTMu//MQxJ4AAANIAAAAADEwMSAoYmVMQU1FMy7/8xDEqwAAA0gAAAAAMTAxIChiZUxBTUUzLv/zEMS4AAADSAAAAAAxMDEgKGJldExBTUUz//MQxMUAAANIAAAAAC4xMDEgKGJlTEFNRTP/8xDE0gAAA0gAAAAALjEwMSAoYmVMQU1FM//zEsTfAAADSAAAAAAuMTAxIChiZUxBTUUzLv/zEMTtAAADSAAAAAAxMDEgKGJlTEFNRTMu//MQxPIAAANIAAAAADEwMSAoYmVMQU1FMy7/8xDE8gAAA0gAAAAAMTAxIChiZUxBTUUzLv/zEMTyAAADSAAAAAAxMDEgKGJlTEFNRTMu//MQxPIAAANIAAAAADEwMSAoYmV0YSAzKVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MSxPEAAANIAAAAAFVVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xLE8QAAA0gAAAAAVVVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVQ==',
    'base64'
  )
  const outputs = new Map<string, boolean>()
  let thread: AgentThreadState | null = null
  const sent: Array<{ generationTools?: string[]; responseMode?: string }> = []
  await page.route(/\/_api\/agents(?:\/|$)/, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (/\/media\/[^/]+\/content$/.test(path)) {
      const isVideo = outputs.get(path.split('/').at(-2)!)
      return route.fulfill({ contentType: isVideo ? 'video/mp4' : 'audio/mpeg', body: isVideo ? videoBytes : musicBytes })
    }
    if (thread && path === `/_api/agents/sessions/${fixture.sessionId}` && request.method() === 'GET') {
      thread = renewFixtureThreadResolution(thread)
      return route.fulfill({ json: thread })
    }
    if (thread && path.endsWith(`/sessions/${fixture.sessionId}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON() as { content: string; generationTools: string[]; responseMode?: string }
      sent.push(body)
      const generatedMedia: AgentMediaView[] = body.generationTools.map(tool => {
        const video = tool === 'video'
        const id = crypto.randomUUID()
        outputs.set(id, video)
        return {
          id,
          kind: video ? 'generated-video' : 'generated-audio',
          filename: video ? 'generated-video.mp4' : 'generated-music.mp3',
          mimeType: video ? 'video/mp4' : 'audio/mpeg',
          byteLength: 100,
          available: true
        }
      })
      const now = new Date().toISOString()
      const run = {
        id: crypto.randomUUID(),
        sessionId: fixture.sessionId,
        status: 'succeeded' as const,
        attempt: 1,
        eventSequence: 2,
        canCancel: false,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        errorCode: null,
        errorMessage: null
      }
      thread = {
        ...thread,
        session: { ...thread.session, version: thread.session.version + 1, currentRun: run },
        messages: [
          ...thread.messages,
          {
            id: crypto.randomUUID(),
            runId: run.id,
            ordinal: thread.messages.length,
            role: 'user',
            status: 'complete',
            content: body.content,
            citations: [],
            createdAt: now,
            updatedAt: now
          },
          {
            id: crypto.randomUUID(),
            runId: run.id,
            ordinal: thread.messages.length + 1,
            role: 'assistant',
            status: 'complete',
            content: 'Here is the composition and accompanying video.',
            citations: [],
            createdAt: now,
            updatedAt: now,
            media: generatedMedia
          }
        ]
      }
      return route.fulfill({ status: 202, json: { run, replayed: false } })
    }
    return route.fallback()
  })
  const initialThread = page.waitForResponse(response => {
    const path = new URL(response.url()).pathname
    return (
      (path === `/_api/agents/sessions/${fixture.sessionId}` && response.request().method() === 'GET') ||
      (path === '/_api/agents/sessions' && response.request().method() === 'POST')
    )
  })
  const agent = await openAgent(page)
  thread = (await (await initialThread).json()) as AgentThreadState
  const input = agent.locator('.agent-composer textarea')
  const trigger = agent.getByRole('button', { name: 'Choose creation tools', exact: true })
  await expectLocatorWithinViewport(trigger, 'Creation tools control')
  await expect(agent.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0)
  await trigger.click()
  const menu = page.locator('[aria-label="Creation tools"]')
  await expect(menu.getByText('Images', { exact: true })).toHaveCount(0)
  await expect(menu.getByText('Text', { exact: true })).toHaveCount(0)
  const videoTool = menu.getByRole('menuitemcheckbox', { name: 'Video', exact: true })
  const musicTool = menu.getByRole('menuitemcheckbox', { name: 'Music', exact: true })
  await videoTool.click()
  await expect(menu).toHaveCount(0)
  // Use the owned native menu key while Vuetify guards post-selection pointer reopening.
  await trigger.press('ArrowDown')
  await musicTool.click()
  await expect(menu).toHaveCount(0)
  await trigger.press('ArrowDown')
  await expect(videoTool).toHaveAttribute('aria-checked', 'true')
  await expect(musicTool).toHaveAttribute('aria-checked', 'true')
  await expectLocatorWithinViewport(menu, 'Creation tools menu')
  await expect.poll(() => menu.evaluate(element => getComputedStyle(element.closest('.v-overlay__content') ?? element).opacity)).toBe('1')
  const menuScreenshot = test.info().outputPath('agent-creation-tools-menu.png')
  await page.screenshot({ path: menuScreenshot })
  await test.info().attach('agent-creation-tools-menu', { path: menuScreenshot, contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await input.fill('Compose ambient piano music and create an accompanying sunrise video. Explain your choices.')
  await agent.getByRole('button', { name: 'Send', exact: true }).click()
  for (const kind of ['video', 'audio']) {
    const player = agent.locator(kind)
    await expect(player).toBeVisible()
    await expect(player).toHaveAttribute('controls', '')
    await expect(player).toHaveAttribute('preload', 'metadata')
    await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1)
    await player.evaluate(element => (element as HTMLMediaElement).play())
    await expect.poll(() => player.evaluate(element => (element as HTMLMediaElement).currentTime)).toBeGreaterThan(0)
    await player.evaluate(element => (element as HTMLMediaElement).pause())
    await expect(player).not.toHaveAttribute('autoplay')
    await player.scrollIntoViewIfNeeded()
    if (kind === 'video' && await player.evaluate(element => {
      const transcript = element.closest('.inline-agent__transcript')
      return transcript !== null && element.getBoundingClientRect().top < transcript.getBoundingClientRect().top
    })) {
      // Read the earlier video output without fighting the transcript's live following.
      await agent.getByRole('region', { name: 'Conversation transcript', exact: true }).focus()
      for (let step = 0; step < 4; step += 1) await page.keyboard.press('PageUp')
    }
    await expectLocatorWithinViewport(player, `${kind} player`)
  }
  expect(sent[0]?.generationTools).toEqual(['video', 'music'])
  expect(sent[0]?.responseMode).toBeUndefined()
  await trigger.click()
  await expect(videoTool).toHaveAttribute('aria-checked', 'true')
  await expect(musicTool).toHaveAttribute('aria-checked', 'true')
  await musicTool.click()
  await trigger.click()
  await expect(musicTool).toHaveAttribute('aria-checked', 'false')
  await expect(videoTool).toHaveAttribute('aria-checked', 'true')
  await videoTool.click()
  await input.fill('Now explain the scene without creating any more media.')
  await agent.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]?.generationTools).toEqual([])
  expect(sent[1]?.responseMode).toBeUndefined()
  await expect(input).toHaveValue('')
  await expect(menu).not.toBeVisible()
  const screenshot = test.info().outputPath('agent-creation-tools.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('agent-creation-tools', { path: screenshot, contentType: 'image/png' })
  fixture.assertNoUnexpectedRequests()
})
