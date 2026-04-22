const { TextDecoder, TextEncoder } = require('util')
const { Blob, File } = require('buffer')
const { ReadableStream, WritableStream, TransformStream } = require('stream/web')
const { MessageChannel, MessagePort } = require('worker_threads')

if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder
}

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder
}

if (typeof global.ReadableStream === 'undefined') {
  global.ReadableStream = ReadableStream
}

if (typeof global.WritableStream === 'undefined') {
  global.WritableStream = WritableStream
}

if (typeof global.TransformStream === 'undefined') {
  global.TransformStream = TransformStream
}

if (typeof global.Blob === 'undefined') {
  global.Blob = Blob
}

if (typeof global.File === 'undefined') {
  global.File = File
}

if (typeof global.MessageChannel === 'undefined') {
  global.MessageChannel = MessageChannel
}

if (typeof global.MessagePort === 'undefined') {
  global.MessagePort = MessagePort
}

if (typeof global.DOMException === 'undefined' && typeof DOMException !== 'undefined') {
  global.DOMException = DOMException
}

if (typeof global.fetch === 'undefined' && typeof fetch !== 'undefined') {
  global.fetch = fetch
}

if (typeof global.Headers === 'undefined' && typeof Headers !== 'undefined') {
  global.Headers = Headers
}

if (typeof global.Request === 'undefined' && typeof Request !== 'undefined') {
  global.Request = Request
}

if (typeof global.Response === 'undefined' && typeof Response !== 'undefined') {
  global.Response = Response
}

if (typeof global.FormData === 'undefined' && typeof FormData !== 'undefined') {
  global.FormData = FormData
}

if (typeof global.AbortController === 'undefined' && typeof AbortController !== 'undefined') {
  global.AbortController = AbortController
}

if (typeof global.AbortSignal === 'undefined' && typeof AbortSignal !== 'undefined') {
  global.AbortSignal = AbortSignal
}
