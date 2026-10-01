import { CommentApiError, createComment, fetchComments, fetchMentionCandidates } from './comments-api.ts'

function createJsonResponse (payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

describe('comments api helper', () => {
  test('scopes comment listing to an unambiguous page identifier', async () => {
    const comments = [{
      id: 31,
      render: '<p>Owner comment</p>',
      authorName: 'Owner',
      replyTo: 0,
      authorHandle: 'owner',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(comments))

    expect(await fetchComments(fetchImpl, 17)).toEqual(comments)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments?pageId=17', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })
  test('preserves clear comment content in typed rows for uncertain-create reconciliation', async () => {
    const source = 'Useful guide'
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{
      id: 31,
      pageId: 17,
      content: source,
      render: 'rendered comment',
      authorName: 'Owner',
      replyTo: 0,
      authorHandle: 'owner',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }]))

    await expect(fetchComments(fetchImpl, 17)).resolves.toEqual([{
      id: 31,
      render: 'rendered comment',
      content: source,
      authorName: 'Owner',
      replyTo: 0,
      authorHandle: 'owner',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }])
  })


  test('scopes mention discovery to the current page and validates candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 7, handle: 'alice', name: 'Alice' }]))
    expect(await fetchMentionCandidates(fetchImpl, 17, 'ali')).toEqual([{ id: 7, handle: 'alice', name: 'Alice' }])
    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments/mentions?pageId=17&q=ali', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  test('propagates JSON rejection details from comment reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Page comments are not permitted' }, 403))
    const request = fetchComments(fetchImpl, 17, 'Bad comments load')

    await expect(request).rejects.toBeInstanceOf(CommentApiError)
    await expect(request).rejects.toMatchObject({
      message: 'Page comments are not permitted',
      status: 403,
      kind: 'permission',
      operation: 'read',
      outcome: 'rejected'
    })
  })

  test('rejects non-JSON successful comment reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[]', {
      headers: { 'Content-Type': 'text/plain' }
    }))
    const request = fetchComments(fetchImpl, 17, 'Bad comments content type')

    await expect(request).rejects.toBeInstanceOf(CommentApiError)
    await expect(request).rejects.toMatchObject({
      message: 'Bad comments content type',
      status: 200,
      kind: 'server',
      operation: 'read',
      outcome: 'rejected'
    })
  })

  test('creates a comment with same-origin JSON POST options and preserves its saved identity', async () => {
    const input = {
      pageId: 17,
      replyTo: 31,
      content: 'Useful reply',
      guestName: 'Guest',
      guestEmail: 'guest@example.test'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ id: 53 }, 201))

    expect(await createComment(fetchImpl, input)).toEqual({ id: 53 })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    })
  })

  test('propagates JSON rejection details from comment creates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Comment content is required' }, 422))
    const request = createComment(fetchImpl, {
      pageId: 17,
      replyTo: 0,
      content: '',
      guestName: 'Guest',
      guestEmail: 'guest@example.test'
    }, 'Bad comment create')

    await expect(request).rejects.toBeInstanceOf(CommentApiError)
    await expect(request).rejects.toMatchObject({
      message: 'Comment content is required',
      status: 422,
      kind: 'validation',
      operation: 'create',
      outcome: 'rejected'
    })
  })

  test('treats a non-JSON successful create as unknown rather than acknowledging it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"id":53}', {
      status: 201,
      headers: { 'Content-Type': 'text/plain' }
    }))
    const request = createComment(fetchImpl, {
      pageId: 17,
      replyTo: 0,
      content: 'Useful guide',
      guestName: 'Guest',
      guestEmail: 'guest@example.test'
    }, 'Bad comment create content type')

    await expect(request).rejects.toBeInstanceOf(CommentApiError)
    await expect(request).rejects.toMatchObject({
      message: 'Bad comment create content type',
      status: 201,
      kind: 'server',
      operation: 'create',
      outcome: 'unknown'
    })
  })

})
