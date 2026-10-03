import { describe, expect, it } from '../../server/test/bun-test.mts'
import { validateAgentAttachment } from './agent-media.ts'
import { agentMediaContentUrl, deleteAgentMedia, getAgentTranscription, startAgentTranscription, uploadAgentMedia } from './agents-api.ts'
const sessionId = '00000000-0000-4000-8000-000000000081'
const mediaId = '00000000-0000-4000-8000-000000000082'
const media = { id: mediaId, kind: 'attachment', filename: 'diagram.png', mimeType: 'image/png', byteLength: 3, available: true, detached: false }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
describe('Agent private media boundary', () => {
  it('accepts bounded raster images and PDFs but rejects active or empty content', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
      expect(validateAgentAttachment({ type, size: 10 * 1024 * 1024 })).toBeNull()
    expect(validateAgentAttachment({ type: 'image/svg+xml', size: 200 })).not.toBeNull()
    expect(validateAgentAttachment({ type: 'text/html', size: 200 })).not.toBeNull()
    expect(validateAgentAttachment({ type: 'image/png', size: 0 })).not.toBeNull()
    expect(validateAgentAttachment({ type: 'application/pdf', size: 250 * 1024 * 1024 })).toBeNull()
    expect(validateAgentAttachment({ type: 'application/pdf', size: 250 * 1024 * 1024 + 1 })).not.toBeNull()
    expect(validateAgentAttachment({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).not.toBeNull()
  })
  it('uploads multipart bytes with CSRF and browser-generated boundaries, never a JSON content type', async () => {
    let seen = false
    const fetcher: typeof fetch = async (input, init) => {
      expect(input).toBe(`/_api/agents/sessions/${sessionId}/media`)
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('same-origin')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-wiki-csrf')).toBe('signed-csrf')
      expect(headers.has('content-type')).toBe(false)
      expect(init?.body).toBeInstanceOf(FormData)
      if (!(init?.body instanceof FormData)) throw new Error('Expected multipart upload')
      const file = init.body.get('file')
      expect(file).toBeInstanceOf(File)
      if (!(file instanceof File)) throw new Error('Expected uploaded File')
      expect(file.name).toBe('diagram.png')
      expect(file.type).toBe('image/png')
      expect(await file.text()).toBe('abc')
      seen = true
      return response({ media }, 201)
    }
    expect(await uploadAgentMedia(fetcher, 'signed-csrf', sessionId, new File(['abc'], 'diagram.png', { type: 'image/png' }))).toEqual(media)
    expect(seen).toBe(true)
  })
  it('surfaces upload denial and validates media responses before showing a preview', async () => {
    await expect(uploadAgentMedia(async () => response({ message: 'Media is disabled.' }, 403), 'csrf', sessionId, new File(['a'], 'a.png'))).rejects.toThrow(
      'Media is disabled.'
    )
    await expect(
      uploadAgentMedia(async () => response({ media: { ...media, id: 'https://remote/image' } }), 'csrf', sessionId, new File(['a'], 'a.png'))
    ).rejects.toThrow('invalid response')
    expect(agentMediaContentUrl(mediaId)).toBe(`/_api/agents/media/${mediaId}/content`)
  })
  it('deletes unbound uploads through the authenticated write endpoint', async () => {
    let requests = 0
    await deleteAgentMedia(
      async (input, init) => {
        requests++
        expect(input).toBe(`/_api/agents/media/${mediaId}`)
        expect(init?.method).toBe('DELETE')
        expect(init?.credentials).toBe('same-origin')
        expect(new Headers(init?.headers).get('x-wiki-csrf')).toBe('csrf')
        return new Response(null, { status: 204 })
      },
      'csrf',
      mediaId
    )
    expect(requests).toBe(1)
  })
  it('admits dictation with the session fence and reads only validated run results', async () => {
    const request = { clientRequestId: crypto.randomUUID(), expectedSessionVersion: 4, profileResolutionToken: 'signed-resolution', attachmentId: mediaId }
    const runId = await startAgentTranscription(
      async (input, init) => {
        expect(input).toBe(`/_api/agents/sessions/${sessionId}/transcriptions`)
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('x-wiki-csrf')).toBe('csrf')
        expect(JSON.parse(String(init?.body))).toEqual(request)
        return response({ runId: mediaId }, 202)
      },
      'csrf',
      sessionId,
      request
    )
    expect(runId).toBe(mediaId)
    const requests: { input: RequestInfo | URL; credentials: RequestCredentials | undefined }[] = []
    const transcriptFetcher =
      (value: unknown): typeof fetch =>
      async (input, init) => {
        requests.push({ input, credentials: init?.credentials })
        return response(value)
      }
    expect(await getAgentTranscription(transcriptFetcher({ status: 'succeeded', text: 'An editable draft' }), 'csrf', runId)).toEqual({
      status: 'succeeded',
      text: 'An editable draft'
    })
    await expect(getAgentTranscription(transcriptFetcher({ status: 'succeeded', text: { html: '<script>' } }), 'csrf', runId)).rejects.toThrow(
      'invalid response'
    )
    expect(requests).toEqual([
      { input: `/_api/agents/runs/${mediaId}/transcription`, credentials: 'same-origin' },
      { input: `/_api/agents/runs/${mediaId}/transcription`, credentials: 'same-origin' }
    ])
  })
})
