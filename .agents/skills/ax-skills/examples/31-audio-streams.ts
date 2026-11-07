import assert from 'node:assert/strict';
import { ai, AxAIMetaModel, axAIOpenAIAudioDefaultConfig, type AxChatRequest } from '@ax-llm/ax';
import { type Example } from './support.js';

// A local transport for the exact 25.4.9 Meta ASR grammar. Ax owns upload
// pacing, turn ordering, caption snapshots, errors and cancellation. No server,
// microphone or account exists; synthetic PCM proves no recognition quality.
function metaFixture(mode: 'captions' | 'delta' | 'cancel' | 'early-close' | 'error') {
  const sockets: MetaSocket[] = [];
  class MetaSocket extends EventTarget {
    readonly sent: (Record<string, unknown> | Uint8Array)[] = [];
    closed = false;
    binaryType = 'arraybuffer';
    constructor(readonly url: string) {
      super(); sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    receive(frame: object): void {
      queueMicrotask(() => {
        if (!this.closed) this.dispatchEvent(new MessageEvent('message', {
          data: new TextEncoder().encode(JSON.stringify(frame)).buffer,
        }));
      });
    }
    send(data: string | Uint8Array): void {
      assert.equal(this.closed, false);
      if (typeof data === 'string') {
        const frame = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(frame);
        if (frame.authorization) {
          assert.equal(frame.audioEncoding, 'PCM_16KHZ');
          assert.equal(frame.partialMode, mode === 'delta' ? 'DELTA' : 'CUMULATIVE');
          this.receive({ sessionId: 'fixture-session' });
        } else if (frame.type === 'endStream') {
          queueMicrotask(() => this.serverClose(1000));
        }
        return;
      }
      this.sent.push(data);
      if (this.sent.filter(item => item instanceof Uint8Array).length !== 1) return;
      if (mode === 'early-close') { queueMicrotask(() => this.serverClose(1000)); return; }
      if (mode === 'error') { this.receive({ type: 'error', message: 'Fixture quota exhausted' }); return; }
      if (mode === 'delta') {
        this.receive({ type: 'speechStart', turnId: 'delta-turn' });
        this.receive({ type: 'transcript', transcript: 'Ship ', final: false });
        this.receive({ type: 'transcript', transcript: 'crate', final: false });
        this.receive({ type: 'transcript', transcript: 'Ship the crate.', final: true });
        return;
      }
      this.receive({ type: 'speechStart', turnId: 'first', audioProcessedMs: 0 });
      this.receive({ type: 'transcript', transcript: 'Ship the red crate', final: false, audioProcessedMs: 10 });
      if (mode === 'cancel') return;
      // Revision removes words: replacing snapshots is essential, concatenation is wrong.
      this.receive({ type: 'transcript', transcript: 'Ship the crate', final: false, audioProcessedMs: 20 });
      this.receive({ type: 'speaker', label: 'operator', audioProcessedMs: 20 });
      this.receive({ type: 'speechStart', turnId: 'second', audioProcessedMs: 20 });
      this.receive({ type: 'transcript', transcript: 'Confirmed.', final: true, audioProcessedMs: 30 });
      // Second finishes first. Ax must emit finalized content in speech-start order.
      this.receive({ type: 'speechComplete', turnId: 'first', transcript: 'Ship the crate.', audioProcessedMs: 40 });
      this.receive({ type: 'audioProgress', audioProcessedMs: 40 });
      this.receive({ type: 'speechEnd', turnId: 'first', audioProcessedMs: 40 });
    }
    serverClose(code: number): void {
      if (this.closed) return;
      this.closed = true;
      const event = new Event('close');
      Object.defineProperty(event, 'code', { value: code });
      this.dispatchEvent(event);
    }
    close(): void { this.serverClose(1000); }
  }
  return { Socket: MetaSocket, sockets };
}
function pcmRequest(bytes = 4): AxChatRequest {
  return { chatPrompt: [{ role: 'user', content: [{ type: 'audio',
    data: Buffer.alloc(bytes).toString('base64'), format: 'pcm16', sampleRate: 16000, channels: 1,
  }] }] };
}

export const examples: readonly Example[] = [
  {
    id: '31-audio-streams/openai-http-deltas', title: 'Decode streamed PCM chunks and transcripts through HTTP SSE',
    features: ['audio-stream', 'SSE', 'isDelta', 'pcm16', 'voice', 'transcript-deltas'], modes: ['offline'],
    async run(ctx) {
      let requests = 0;
      const llm = ai({ name: 'openai', apiKey: 'fixture-not-a-key', config: axAIOpenAIAudioDefaultConfig(),
        options: { fetch: async (_url, init) => {
          requests++;
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(body.stream, true);
          assert.deepEqual(body.audio, { voice: 'alloy', format: 'pcm16' });
          const deltas = [
            { role: 'assistant', audio: { id: 'audio-stream', data: 'AAAA', transcript: 'Hello ' } },
            { audio: { id: 'audio-stream', data: 'AQAA', transcript: 'dispatch.' } },
          ];
          const events: object[] = deltas.map(delta => ({ id: 'http-audio', object: 'chat.completion.chunk', created: 0,
            model: 'gpt-audio-mini', choices: [{ index: 0, delta, finish_reason: null }] }));
          events.push({ id: 'http-audio', object: 'chat.completion.chunk', created: 0, model: 'gpt-audio-mini',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
          return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
        } } });
      const response = await llm.chat({ chatPrompt: [{ role: 'user', content: 'Greet dispatch out loud.' }],
        modelConfig: { audio: { output: { enabled: true, voice: 'alloy', format: 'pcm16', includeTranscript: true } } } },
        { stream: true, abortSignal: ctx.signal });
      assert.ok(!('results' in response));
      const reader = response.getReader();
      const pcm: Buffer[] = []; let transcript = '';
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          for (const result of value.results) {
            if (result.audio) {
              assert.equal(result.audio.isDelta, true);
              pcm.push(Buffer.from(result.audio.data, 'base64'));
              transcript += result.audio.transcript ?? '';
            }
          }
        }
      } finally { reader.releaseLock(); }
      assert.equal(Buffer.concat(pcm).length, 6);
      assert.equal(transcript, 'Hello dispatch.');
      await assert.rejects(() => llm.chat({ chatPrompt: [{ role: 'user', content: 'Use unsupported OGG output.' }],
        modelConfig: { audio: { output: { enabled: true, format: 'ogg' } } } }, { stream: true }), /ogg format/);
      assert.equal(requests, 1);
      return { bytes: 6, transcript, format: 'pcm16',
        boundary: 'Decode each base64 chunk separately; chunks are not individually playable WAV files',
        realPrerequisite: 'OpenAI audio chat streaming access and a PCM sink; this fixture uses neither playback nor a device' };
    },
  },
  {
    id: '31-audio-streams/meta-caption-revisions', title: 'Replace caption snapshots and append final turns exactly once',
    features: ['meta-realtime', 'caption-revision', 'overlapping-turns', 'speaker', 'audio-progress', 'endStream'], modes: ['offline'],
    async run(ctx) {
      const fixture = metaFixture('captions');
      const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', config: {
        model: AxAIMetaModel.MuseVoiceTranscribe10, realtimeTranscription: {
          mode: 'diarization', partialMode: 'cumulative', languageBias: ['en'], keywords: ['crate'], emitAudioProgress: true,
        },
      } });
      const response = await meta.chat(pcmRequest(), { webSocket: fixture.Socket, stream: true, abortSignal: ctx.signal });
      assert.ok(!('results' in response));
      const reader = response.getReader();
      const captions = new Map<string, { text: string; isFinal: boolean }>();
      const finalized: string[] = []; const revisions: string[] = [];
      const speakers = new Set<string>(); let processed = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          for (const result of value.results) {
            if (result.transcript) {
              assert.ok(result.id);
              captions.set(result.id, result.transcript);
              if (result.id === 'first') revisions.push(result.transcript.text);
            }
            if (result.content) finalized.push(result.content);
            if (result.name) speakers.add(result.name);
            processed = Math.max(processed, result.audioProcessedMs ?? 0);
            assert.equal(result.audio, undefined, 'Muse Voice is STT only');
          }
        }
        assert.ok(fixture.sockets.every(socket => socket.closed), 'SDK gracefully closes the completed ASR transport');
      } finally {
        reader.releaseLock();
        for (const socket of fixture.sockets) socket.close();
      }
      assert.deepEqual(captions.get('first'), { text: 'Ship the crate.', isFinal: true });
      assert.deepEqual(captions.get('second'), { text: 'Confirmed.', isFinal: true });
      assert.ok(revisions.includes('Ship the red crate'));
      assert.ok(revisions.includes('Ship the crate'));
      assert.deepEqual(finalized, ['Ship the crate.', 'Confirmed.']);
      assert.ok(speakers.has('operator')); assert.equal(processed, 40);
      const socket = fixture.sockets[0]; assert.ok(socket);
      assert.match(socket.url, /\/asr\/realtime/);
      assert.equal(socket.closed, true);
      assert.ok(socket.sent.some(item => !(item instanceof Uint8Array) && item.type === 'endStream'));
      return { captions: Object.fromEntries(captions), finalized, processedMs: processed, gracefullyClosed: socket.closed,
        realPrerequisite: 'Meta Muse Voice realtime ASR access, mono PCM16 at 16/24 kHz; no speech output' };
    },
  },
  {
    id: '31-audio-streams/meta-delta-partials', title: 'Normalize provider delta partials into replacement caption snapshots',
    features: ['meta-delta-partials', 'transcript-snapshots', 'final-replacement'], modes: ['offline'],
    async run(ctx) {
      const fixture = metaFixture('delta');
      const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', config: {
        model: AxAIMetaModel.MuseVoiceTranscribe10, realtimeTranscription: { partialMode: 'delta' },
      } });
      const stream = await meta.chat(pcmRequest(), { webSocket: fixture.Socket, stream: true, abortSignal: ctx.signal });
      assert.ok(!('results' in stream));
      const snapshots: string[] = []; const finalized: string[] = [];
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          for (const result of value.results) {
            if (result.transcript) snapshots.push(result.transcript.text);
            if (result.content) finalized.push(result.content);
          }
        }
        assert.ok(fixture.sockets.every(socket => socket.closed), 'SDK closes the completed delta transport');
      } finally {
        reader.releaseLock();
        for (const socket of fixture.sockets) socket.close();
      }
      assert.deepEqual(snapshots, ['Ship ', 'Ship crate', 'Ship the crate.', 'Ship the crate.']);
      assert.deepEqual(finalized, ['Ship the crate.']);
      assert.equal(fixture.sockets[0]?.closed, true);
      return { snapshots, finalized, rule: 'Even in provider delta mode, Ax transcript values are replacement snapshots; final transcript replaces accumulated partials' };
    },
  },
  {
    id: '31-audio-streams/meta-cancel-upload', title: 'Cancel caption consumption while PCM upload is still in progress',
    features: ['stream-cancel', 'abort', 'paced-audio-upload', 'socket-close'], modes: ['offline'],
    async run(ctx) {
      const fixture = metaFixture('cancel');
      const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', config: {
        model: AxAIMetaModel.MuseVoiceTranscribe10, realtimeTranscription: { partialMode: 'cumulative' },
      } });
      const stream = await meta.chat(pcmRequest(16000 * 2), { webSocket: fixture.Socket, stream: true, abortSignal: ctx.signal });
      assert.ok(!('results' in stream));
      const reader = stream.getReader();
      try {
        const first = await reader.read();
        assert.equal(first.done, false);
        assert.equal(first.value?.results[0]?.transcript?.text, 'Ship the red crate');
      } finally {
        try { await reader.cancel('The caller navigated away'); }
        finally { reader.releaseLock(); }
      }
      // pipeThrough cancellation propagates to Ax's underlying source asynchronously.
      const settle = Promise.withResolvers<void>();
      setTimeout(settle.resolve, 120);
      await settle.promise;
      const socket = fixture.sockets[0]; assert.ok(socket);
      assert.equal(socket.closed, true);
      assert.equal(socket.sent.filter(item => item instanceof Uint8Array).length, 1, 'Remaining paced PCM chunks must not be transmitted');
      assert.ok(!socket.sent.some(item => !(item instanceof Uint8Array) && item.type === 'endStream'));
      return { cancelled: true, closed: socket.closed, transmittedChunks: 1, unsentAudioDiscarded: true,
        proof: 'actual SDK stream cancellation stops its concurrent paced sender, not a simulated app flag' };
    },
  },
  {
    id: '31-audio-streams/meta-errors-and-encoding', title: 'Reject early close, remote errors and conflicting PCM metadata',
    features: ['early-close-error', 'provider-error', 'sample-rate-conflict', 'mono-pcm16'], modes: ['offline'],
    async run(ctx) {
      for (const mode of ['early-close', 'error'] as const) {
        const fixture = metaFixture(mode);
        const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', config: {
          model: AxAIMetaModel.MuseVoiceTranscribe10, realtimeTranscription: { partialMode: 'cumulative' },
        } });
        const response = await meta.chat(pcmRequest(32000), { webSocket: fixture.Socket, stream: true, abortSignal: ctx.signal });
        assert.ok(!('results' in response));
        const reader = response.getReader();
        await assert.rejects(async () => { try { while (!(await reader.read()).done) { /* Drain to the real provider error. */ } }
          catch (error) {
            assert.ok(fixture.sockets.every(socket => socket.closed), 'SDK closes failed ASR transports');
            throw error;
          }
          finally {
            reader.releaseLock();
            for (const socket of fixture.sockets) socket.close();
          } }, mode === 'early-close' ? /before graceful completion/ : /Fixture quota exhausted/);
        assert.equal(fixture.sockets[0]?.closed, true);
      }
      const fixture = metaFixture('captions');
      const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', config: {
        model: AxAIMetaModel.MuseVoiceTranscribe10, audio: { input: { sampleRate: 24000, channels: 1 } },
      } });
      await assert.rejects(() => meta.chat(pcmRequest(), { webSocket: fixture.Socket, stream: true }), /Conflicting realtime audio sample rates/);
      assert.equal(fixture.sockets.length, 0, 'Conflicting declarations fail before creating a socket');
      return { earlyNormalClose: 'error', remoteError: 'propagated', conflictingSampleRate: 'rejected before transport',
        boundary: 'A normal close is successful only after PCM upload AND endStream; do not swallow provider failures' };
    },
  },
];
