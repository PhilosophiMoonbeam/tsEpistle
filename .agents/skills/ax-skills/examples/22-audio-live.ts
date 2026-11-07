import assert from 'node:assert/strict';
import {
  ai, axAIOpenAIRealtimeDefaultConfig, axAIOpenAIRealtimeTranscriptionDefaultConfig,
  axAIGoogleGeminiLiveAudioDefaultConfig, axAIGrokVoiceDefaultConfig,
} from '@ax-llm/ax';
import { type Example } from './support.js';

// Protocol frames mirror the pinned SDK's openai/realtime.ts,
// google-gemini/live_audio.ts and x-grok/api.ts (25.4.9 sourcesContent).
// This is a transport seam, not a replacement for Ax's session or parser logic.
function fixtureSocket(onSend: (socket: Socket, frame: Record<string, unknown>) => void) {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    readonly url: string;
    binaryType = 'arraybuffer';
    closed = false;
    readonly sent: Record<string, unknown>[] = [];
    constructor(url: string) {
      super(); this.url = url; sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(data: string): void {
      assert.equal(this.closed, false, 'No sends after socket close');
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(frame); onSend(this, frame);
    }
    receive(frame: object, binary = false): void {
      queueMicrotask(() => {
        if (this.closed) return;
        const text = JSON.stringify(frame);
        this.dispatchEvent(new MessageEvent('message', {
          data: binary ? new TextEncoder().encode(text).buffer : text,
        }));
      });
    }
    close(): void {
      if (this.closed) return;
      this.closed = true; this.dispatchEvent(new Event('close'));
    }
  }
  return { Socket, sockets };
}
// Only the send/receive contract is relevant; no socket ever reaches a network.
interface Socket {
  readonly url: string;
  readonly sent: Record<string, unknown>[];
  readonly closed: boolean;
  receive(frame: object, binary?: boolean): void;
}

export const examples: readonly Example[] = [
  {
    id: '22-audio-live/openai-realtime-turn', title: 'Complete one OpenAI realtime speech turn through the public socket seam',
    features: ['openai-realtime', 'session.update', 'pcm16', 'audio-transcript', 'turn-close'], modes: ['offline'],
    async run(ctx) {
      const pcm = Buffer.from([0, 0, 1, 0]).toString('base64');
      const fixture = fixtureSocket((socket, frame) => {
        if (frame.type === 'session.update') {
          assert.match(JSON.stringify(frame), /marin/);
          socket.receive({ type: 'session.updated' });
        }
        if (frame.type === 'response.create') {
          socket.receive({ type: 'response.created', response: { id: 'turn-1' } });
          socket.receive({ type: 'response.output_audio.delta', response_id: 'turn-1', delta: pcm });
          socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'Ready ' });
          socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'to ship.' });
          socket.receive({ type: 'response.output_audio_transcript.done', transcript: 'Ready to ship.' });
          socket.receive({ type: 'response.done', response: { id: 'turn-1', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } });
        }
      });
      const openai = ai({ name: 'openai', apiKey: 'fixture-not-a-key', config: axAIOpenAIRealtimeDefaultConfig() });
      const result = await openai.chat({ chatPrompt: [{ role: 'user', content: [
        { type: 'text', text: 'Confirm the shipping request.' },
        { type: 'audio', data: pcm, format: 'pcm16', sampleRate: 24000, channels: 1 },
      ] }], modelConfig: { maxTokens: 512 } }, { webSocket: fixture.Socket, stream: false, abortSignal: ctx.signal });
      assert.ok('results' in result);
      assert.equal(result.results[0]?.content, 'Ready to ship.');
      assert.equal(result.results[0]?.audio?.transcript, 'Ready to ship.');
      assert.equal(result.results[0]?.audio?.data, pcm);
      const socket = fixture.sockets[0]; assert.ok(socket);
      assert.match(socket.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=/);
      assert.deepEqual(socket.sent.map(frame => frame.type), [
        'session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'conversation.item.create', 'response.create',
      ]);
      assert.equal(socket.closed, true);
      return { transcript: result.results[0]?.content, audioBytes: 4, sessionClosed: socket.closed,
        proof: 'SDK one-turn handshake, upload, decode and completion; synthetic PCM is not voice quality',
        realPrerequisite: 'OpenAI Realtime model entitlement and WebSocket implementation; no microphone required' };
    },
  },
  {
    id: '22-audio-live/openai-realtime-transcription', title: 'Use transcription-only realtime without an output-audio capability',
    features: ['openai-realtime-transcription', 'independent-output-capability', 'input-transcript'], modes: ['offline'],
    async run(ctx) {
      const fixture = fixtureSocket((socket, frame) => {
        if (frame.type === 'transcription_session.update') {
          assert.match(JSON.stringify(frame), /gpt-realtime-whisper/);
          socket.receive({ type: 'transcription_session.updated' });
        }
        if (frame.type === 'input_audio_buffer.commit') {
          socket.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Order ' });
          socket.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Order seven.' });
        }
      });
      const openai = ai({ name: 'openai', apiKey: 'fixture-not-a-key', config: axAIOpenAIRealtimeTranscriptionDefaultConfig() });
      const capability = openai.getFeatures().media?.audio;
      assert.equal(capability?.output?.supported, false);
      const response = await openai.chat({ chatPrompt: [{ role: 'user', content: [
        { type: 'audio', data: 'AAAAAA==', format: 'pcm16', sampleRate: 24000, channels: 1 },
      ] }] }, { webSocket: fixture.Socket, stream: false, abortSignal: ctx.signal });
      assert.ok('results' in response);
      assert.equal(response.results[0]?.content, 'Order seven.');
      assert.equal(response.results[0]?.audio, undefined);
      const socket = fixture.sockets[0]; assert.ok(socket);
      assert.match(socket.url, /transcription_sessions/);
      assert.ok(!socket.sent.some(frame => frame.type === 'response.create'));
      assert.equal(socket.closed, true);
      return { transcript: response.results[0]?.content, outputAudio: false,
        realPrerequisite: 'OpenAI realtime transcription endpoint access; this is not speech-to-speech' };
    },
  },
  {
    id: '22-audio-live/grok-voice-turn', title: 'Map Grok Voice onto its own realtime session contract',
    features: ['grok-voice', 'voice', 'realtime-pcm16', 'provider-boundary'], modes: ['offline'],
    async run(ctx) {
      const fixture = fixtureSocket((socket, frame) => {
        if (frame.type === 'session.update') {
          assert.deepEqual(frame.session, { voice: 'eve', turn_detection: null,
            audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } } });
          socket.receive({ type: 'session.updated' });
        }
        if (frame.type === 'response.create') {
          socket.receive({ type: 'response.audio.delta', delta: 'AAABAA==' });
          socket.receive({ type: 'response.audio_transcript.delta', delta: 'Hello from dispatch.' });
          socket.receive({ type: 'response.done', response: { id: 'grok-turn' } });
        }
      });
      const grok = ai({ name: 'grok', apiKey: 'fixture-not-a-key', config: axAIGrokVoiceDefaultConfig() });
      const response = await grok.chat({ chatPrompt: [{ role: 'user', content: 'Greet the dispatch team.' }] },
        { webSocket: fixture.Socket, stream: false, abortSignal: ctx.signal });
      assert.ok('results' in response);
      assert.equal(response.results[0]?.audio?.transcript, 'Hello from dispatch.');
      assert.equal(response.results[0]?.audio?.data, 'AAABAA==');
      const socket = fixture.sockets[0]; assert.ok(socket);
      assert.match(socket.url, /^wss:\/\/api\.x\.ai\/v1\/realtime/);
      assert.equal(socket.closed, true);
      return { transcript: response.results[0]?.content, voice: 'eve', endpoint: 'xAI realtime, not OpenAI',
        realPrerequisite: 'xAI Grok Voice access and runtime WebSocket constructor' };
    },
  },
  {
    id: '22-audio-live/gemini-binary-live-turn', title: 'Wait through Gemini acknowledgement, thought, and final audio turns',
    features: ['gemini-live', 'binary-frames', 'turn-complete', 'thought', 'output-transcription', 'voice'], modes: ['offline'],
    async run(ctx) {
      const fixture = fixtureSocket((socket, frame) => {
        if (frame.setup) {
          assert.match(JSON.stringify(frame), /Kore/);
          assert.match(JSON.stringify(frame), /outputAudioTranscription/);
          socket.receive({ setupComplete: {} }, true);
        }
        const realtime = frame.realtimeInput;
        if (typeof realtime === 'object' && realtime !== null && 'audioStreamEnd' in realtime) {
          socket.receive({ serverContent: { outputTranscription: { text: 'Checking.' }, modelTurn: { parts: [
            { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          ] }, turnComplete: true, interactionStatus: 'IN_PROGRESS' } }, true);
          socket.receive({ serverContent: { modelTurn: { parts: [{ text: 'Checking the schedule.', thought: true }] } } }, true);
          socket.receive({ serverContent: { outputTranscription: { text: 'Ready.' }, modelTurn: { parts: [
            { inlineData: { data: 'AQAA', mimeType: 'audio/pcm;rate=24000' } },
          ] }, turnComplete: true }, usageMetadata: { promptTokenCount: 2, responseTokenCount: 3, totalTokenCount: 5 } }, true);
        }
      });
      // Unlike the other providers, 25.4.9 Gemini Live does NOT read
      // options.webSocket. Own this global replacement for the awaited call only;
      // run sequentially and always restore it, even on error. No live credentials.
      const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
      Object.defineProperty(globalThis, 'WebSocket', { value: fixture.Socket, configurable: true, writable: true });
      try {
        const gemini = ai({ name: 'google-gemini', apiKey: 'fixture-not-a-key', config: axAIGoogleGeminiLiveAudioDefaultConfig() });
        const response = await gemini.chat({ chatPrompt: [{ role: 'user', content: [
          { type: 'text', text: 'Confirm the dispatch schedule.' },
          { type: 'audio', data: 'AAAAAA==', format: 'pcm16', sampleRate: 16000, channels: 1 },
        ] }] }, { stream: false, abortSignal: ctx.signal });
        assert.ok('results' in response);
        assert.equal(response.results[0]?.content, 'Checking. Ready.');
        assert.equal(response.results[0]?.thought, 'Checking the schedule.');
        assert.equal(response.results[0]?.audio?.format, 'pcm16');
        assert.equal(response.results[0]?.audio?.sampleRate, 24000);
        assert.equal(response.results[0]?.audio?.channels, 1);
        assert.equal(Buffer.from(response.results[0]?.audio?.data ?? '', 'base64').length, 6);
        const socket = fixture.sockets[0]; assert.ok(socket);
        assert.match(socket.url, /GenerativeService\.BidiGenerateContent/);
        assert.equal(socket.closed, true);
        assert.match(JSON.stringify(socket.sent), /audioStreamEnd/);
        return { transcript: response.results[0]?.content, thought: response.results[0]?.thought,
          inputHz: 16000, outputHz: 24000, audioBytes: 6, closed: socket.closed,
          realPrerequisite: 'Gemini Live entitlement, global WebSocket and mono PCM input; text-provider keys alone do not establish Live access' };
      } finally {
        if (original) Object.defineProperty(globalThis, 'WebSocket', original);
        else Reflect.deleteProperty(globalThis, 'WebSocket');
      }
    },
  },
];
