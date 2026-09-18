import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { describe, expect, it } from '../bun-test.mts'
import { AgentMediaUploadGate, parseAgentMediaUpload } from '../../agents/media-upload.ts'

describe('Agent media upload admission', () => {
  it('rejects a second concurrent owner upload before its parser can allocate memory, then releases capacity', async () => {
    const gate = new AgentMediaUploadGate()
    const first = Promise.withResolvers<void>()
    const running = gate.run(7, () => first.promise)
    let invoked = false
    await expect(
      gate.run(7, async () => {
        invoked = true
      })
    ).rejects.toMatchObject({ status: 429, code: 'AGENT_MEDIA_UPLOAD_BUSY' })
    expect(invoked).toBe(false)
    first.resolve()
    await running
    await gate.run(7, async () => {
      invoked = true
    })
    expect(invoked).toBe(true)
  })

  it('bounds all owners to two uploads and releases failed operations', async () => {
    const gate = new AgentMediaUploadGate()
    const pending = Array.from({ length: 2 }, () => Promise.withResolvers<void>())
    const running = pending.map((item, index) => gate.run(index, () => item.promise))
    await expect(gate.run(100, async () => undefined)).rejects.toMatchObject({ status: 429 })
    pending.forEach(item => {
      item.resolve()
    })
    await Promise.all(running)
    await expect(
      gate.run(7, async () => {
        throw new Error('invalid file')
      })
    ).rejects.toThrow('invalid file')
    await gate.run(7, async () => undefined)
  })

  it('releases aborted multipart uploads even if the parser never calls back', async () => {
    const gate = new AgentMediaUploadGate()
    const controller = new AbortController()
    let destroyed = 0
    let callback: NextFunction | undefined
    const request = {
      destroy() {
        destroyed += 1
      }
    } as unknown as Request
    const response = {} as Response
    const parser: RequestHandler = (_req, _res, next) => {
      callback = next
    }
    const other = Promise.withResolvers<void>()
    const otherRun = gate.run(8, () => other.promise)
    const abortedRun = gate.run(7, () => parseAgentMediaUpload(parser, request, response, controller.signal))
    controller.abort()
    await expect(abortedRun).rejects.toMatchObject({ code: 'AGENT_MEDIA_UPLOAD_ABORTED' })
    expect(destroyed).toBe(1)
    await gate.run(7, async () => undefined)
    callback?.()
    other.resolve()
    await otherRun
  })

  it('normalizes parser errors and stops already-aborted uploads before parsing', async () => {
    const controller = new AbortController()
    let invoked = false
    const request = { destroy() {} } as unknown as Request
    const response = {} as Response
    const parser: RequestHandler = (_req, _res, next) => {
      invoked = true
      next(new Error('multipart details'))
    }
    await expect(parseAgentMediaUpload(parser, request, response, controller.signal)).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA', status: 400 })
    invoked = false
    controller.abort()
    await expect(parseAgentMediaUpload(parser, request, response, controller.signal)).rejects.toMatchObject({ code: 'AGENT_MEDIA_UPLOAD_ABORTED' })
    expect(invoked).toBe(false)
  })
})
