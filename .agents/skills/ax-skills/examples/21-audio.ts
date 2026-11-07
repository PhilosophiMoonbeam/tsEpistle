import assert from 'node:assert/strict';
import {
  ai, agent, ax, AxJSRuntime, AxMockAIService, AxMediaNotSupportedError,
  AxAIGoogleGeminiModel, axAIOpenAIAudioDefaultConfig,
  type AxChatRequest, type AxChatResponse,
} from '@ax-llm/ax';
import { options, type Example } from './support.js';

// A real, minimal mono PCM16 WAV container containing silence, NOT speech.
// Provider responses below are deterministic transport fixtures: these cases prove
// request mapping, parsing and orchestration, never recognition or voice quality.
function silentWav(): Buffer {
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40);
  return wav;
}
function json(value: unknown): Response { return Response.json(value); }
function chat(content: string): AxChatResponse {
  return { results: [{ index: 0, content, finishReason: 'stop' }] };
}

export const examples: readonly Example[] = [
  {
    id: '21-audio/batch-provider-boundaries', title: 'Respect Mistral voice mapping and OpenAI transcription response formats',
    features: ['mistral-speak', 'voice_id', 'gpt-transcribe', 'text-transcription', 'unsupported-media'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav();
      const mistral = ai({ name: 'mistral', apiKey: 'fixture-not-a-key', options: { fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, 'voxtral-mini-tts-2603');
        assert.equal(body.voice_id, 'fixture-voice-id');
        assert.equal(body.voice, undefined);
        return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
      } } });
      const spoken = await mistral.speak({ text: 'Your parcel is ready.', voice: 'fixture-voice-id', format: 'wav' }, { abortSignal: ctx.signal });
      assert.equal(spoken.transcript, 'Your parcel is ready.');
      assert.equal(spoken.data, wav.toString('base64'));
      const openai = ai({ name: 'openai', apiKey: 'fixture-not-a-key', options: { fetch: async (_url, init) => {
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.body.get('model'), 'gpt-transcribe');
        assert.equal(init.body.get('response_format'), 'text');
        return new Response('Parcel ready.', { headers: { 'content-type': 'text/plain' } });
      } } });
      const heard = await openai.transcribe({ model: 'gpt-transcribe', responseFormat: 'text',
        audio: { data: spoken.data, format: 'wav' } }, { abortSignal: ctx.signal });
      assert.equal(heard.text, 'Parcel ready.');
      const unsupported = ai({ name: 'anthropic', apiKey: 'fixture-not-a-key' });
      await assert.rejects(() => unsupported.transcribe({ audio: { data: spoken.data, format: 'wav' } }), AxMediaNotSupportedError);
      await assert.rejects(() => unsupported.speak({ text: 'Unsupported.' }), AxMediaNotSupportedError);
      return { transcript: heard.text, mistralVoiceField: 'voice_id', unsupported: 'AxMediaNotSupportedError',
        realPrerequisite: 'Mistral TTS access plus a valid provider voice ID; gpt-transcribe accepts json/text, not verbose_json' };
    },
  },
  {
    id: '21-audio/batch-openai', title: 'Choose batch STT and TTS for independent artifacts',
    features: ['transcribe', 'speak', 'multipart', 'pcm16', 'batch-artifact'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav();
      const calls: string[] = [];
      const fetcher: typeof fetch = async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith('/audio/transcriptions')) {
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe');
          assert.equal(init.body.get('language'), 'en');
          const file = init.body.get('file');
          assert.ok(file instanceof Blob);
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
          return json({ text: 'Ship order seven.', language: 'en',
            words: [{ word: 'Ship', start: 0, end: 0.2 }],
            segments: [{ id: 0, text: 'Ship order seven.', start: 0, end: 1, speaker_id: 'operator' }] });
        }
        assert.ok(String(url).endsWith('/audio/speech'));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.input, 'Ship order seven.');
        assert.equal(body.voice, 'alloy');
        assert.equal(body.response_format, 'pcm'); // Ax pcm16 -> OpenAI pcm.
        return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'content-type': 'audio/pcm;rate=24000' } });
      };
      const llm = ai({ name: 'openai', apiKey: 'fixture-not-a-key', options: { fetch: fetcher } });
      const heard = await llm.transcribe({ audio: { data: wav.toString('base64'), format: 'wav' },
        model: 'gpt-4o-mini-transcribe', language: 'en', prompt: 'Shipping desk' }, { abortSignal: ctx.signal });
      assert.equal(heard.segments?.[0]?.speaker, 'operator');
      assert.equal(heard.words?.[0]?.text, 'Ship');
      const spoken = await llm.speak({ text: heard.text, model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'pcm16' }, { abortSignal: ctx.signal });
      assert.equal(spoken.transcript, heard.text);
      assert.equal(spoken.format, 'pcm16');
      assert.equal(spoken.sampleRate, 24000);
      assert.equal(Buffer.from(spoken.data, 'base64').length, 4);
      assert.equal(calls.length, 2);
      return { surface: 'batch artifacts, not conversational audio', transcript: heard.text, format: spoken.format,
        bytes: 4, proof: 'SDK multipart and binary mapping only', livePrerequisite: 'OpenAI STT/TTS endpoint permissions and actual spoken input' };
    },
  },
  {
    id: '21-audio/batch-gemini', title: 'Let Gemini response MIME label synthesized audio',
    features: ['gemini-transcribe', 'gemini-speak', 'voice', 'mime-format'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav().toString('base64');
      let calls = 0;
      const fetcher: typeof fetch = async (url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (calls === 1) {
          assert.match(String(url), /gemini-3\.8-flash-lite-tts/);
          assert.match(JSON.stringify(body), /Puck/);
          return json({ candidates: [{ content: { parts: [{ inlineData: { data: wav, mimeType: 'audio/wav' } }] } }] });
        }
        assert.match(String(url), /gemini-3\.5-transcribe/);
        return json({ candidates: [{ content: { parts: [{ audioTranscription: { text: 'Your order has shipped.' } }] } }] });
      };
      const gemini = ai({ name: 'google-gemini', apiKey: 'fixture-not-a-key', options: { fetch: fetcher } });
      const speech = await gemini.speak({ text: 'Your order has shipped.', model: AxAIGoogleGeminiModel.Gemini38FlashLiteTTS, voice: 'Puck' }, { fetch: fetcher, abortSignal: ctx.signal });
      assert.equal(speech.format, 'wav');
      assert.equal(speech.mimeType, 'audio/wav');
      const heard = await gemini.transcribe({ audio: { data: speech.data, format: speech.format } }, { fetch: fetcher, abortSignal: ctx.signal });
      assert.equal(heard.text, 'Your order has shipped.');
      assert.equal(calls, 2);
      return { voice: 'Puck', format: speech.format, transcript: heard.text,
        proof: 'provider JSON normalization, not a quality roundtrip', livePrerequisite: 'Gemini dedicated transcription and TTS model access' };
    },
  },
  {
    id: '21-audio/batch-meta', title: 'Preserve diarization and correlation in Meta batch transcription',
    features: ['meta-transcribe', 'diarization', 'language-bias', 'keywords', 'session-id'], modes: ['offline'],
    async run(ctx) {
      const meta = ai({ name: 'meta', apiKey: 'fixture-not-a-key', options: { fetch: async (_url, init) => {
        assert.ok(init?.body instanceof FormData);
        const request = init.body.get('request');
        assert.ok(request instanceof Blob);
        const wire = JSON.parse(await request.text()) as Record<string, unknown>;
        assert.equal(wire.mode, 'DIARIZATION');
        assert.deepEqual(wire.languageBias, ['en', 'es']);
        assert.deepEqual(wire.keywords, ['Ax']);
        return json({ transcript: 'Use Ax.', sessionId: 'owned-session', audioDurationMs: 500,
          turns: [{ turnId: 't1', transcript: 'Use Ax.', startMs: 0, endMs: 500, speakerId: 'speaker-1' }] });
      } } });
      const heard = await meta.transcribe({ model: 'muse-voice-transcribe-1.0',
        audio: { data: silentWav().toString('base64'), format: 'wav' }, mode: 'diarization',
        languageBias: ['en', 'es'], keywords: ['Ax'], partialMode: 'delta', emitAudioProgress: true, sessionId: 'owned-session' }, { abortSignal: ctx.signal });
      assert.equal(heard.sessionId, 'owned-session');
      assert.equal(heard.duration, 0.5);
      assert.equal(heard.segments?.[0]?.speaker, 'speaker-1');
      assert.equal(heard.segments?.[0]?.end, 0.5);
      await assert.rejects(() => meta.speak({ text: 'Not supported.' }), AxMediaNotSupportedError);
      return { transcript: heard.text, sessionId: heard.sessionId, segment: heard.segments?.[0],
        outputAudio: false, livePrerequisite: 'Meta Muse Voice ASR access; not a speech synthesizer' };
    },
  },
  {
    id: '21-audio/scripted-signature', title: 'Parse a script, synthesize fields, then reuse the transcript',
    features: ['speech:audio', 'speech.fields', 'speech.speak', 'transcript-input'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav().toString('base64');
      const synthesis: string[] = [];
      let generations = 0;
      const llm = new AxMockAIService<string>({ name: 'deterministic-script-and-speech',
        features: { functions: true, structuredOutputs: false },
        chatResponse: async (request) => {
          generations++;
          if (generations === 1) return chat('Speech: Retries recover temporary failures.\nSummary: Retry transient failures.');
          assert.match(JSON.stringify(request.chatPrompt), /Retries recover temporary failures/);
          assert.ok(!JSON.stringify(request.chatPrompt).includes(wav));
          return chat('Answer: The recording explains retries.');
        },
        speechResponse: (request) => {
          assert.equal(request.voice, 'alloy'); // Field setting overrides common voice.
          assert.equal(request.format, 'wav');
          synthesis.push(request.text);
          return { data: wav, format: 'wav', mimeType: 'audio/wav' };
        },
      });
      const explain = ax('question:string -> speech:audio, summary:string');
      const result = await explain.forward(llm, { question: 'Explain retries in one sentence.' }, {
        ...options(ctx), speech: { speak: { voice: 'nova', format: 'wav' }, fields: { speech: { voice: 'alloy' } } },
      });
      assert.equal(result.speech.transcript, 'Retries recover temporary failures.');
      assert.equal(result.speech.data, wav);
      assert.deepEqual(synthesis, ['Retries recover temporary failures.']);
      const summarize = ax('recording:audio -> answer:string');
      const next = await summarize.forward(llm, { recording: result.speech }, options(ctx));
      assert.equal(next.answer, 'The recording explains retries.');
      return { summary: result.summary, script: result.speech.transcript, next: next.answer,
        selection: 'structured artifact uses forward speech, not modelConfig.audio', proof: 'real parsing/synthesis orchestration with explicitly scripted model and TTS' };
    },
  },
  {
    id: '21-audio/agent-input-transcription', title: 'Transcribe before agent stages and synthesize after response selection',
    features: ['agent-audio', 'input-transcription', 'AxJSRuntime', 'speech-artifact'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav().toString('base64');
      const order: string[] = [];
      let stages = 0;
      const llm = new AxMockAIService<string>({ name: 'deterministic-voice-agent',
        features: { functions: true, structuredOutputs: true },
        transcribeResponse: (request) => {
          assert.equal(request.audio.data, wav); assert.equal(request.language, 'en');
          order.push('transcribe'); return { text: 'Please ship order seven.' };
        },
        chatResponse: async (request: Readonly<AxChatRequest<unknown>>) => {
          assert.equal(order[0], 'transcribe');
          assert.ok(!JSON.stringify(request.chatPrompt).includes(wav));
          stages++;
          assert.ok(stages <= 3, 'The voice agent has exactly two actor stages and one responder');
          const systemText = request.chatPrompt
            .filter((message) => message.role === 'system')
            .map((message) => message.content).join('\n');
          if (/^## Distiller$/m.test(systemText)) {
            assert.equal(stages, 1);
            order.push('distiller');
            assert.match(JSON.stringify(request.chatPrompt), /Please ship order seven/);
            return chat(JSON.stringify({ javascriptCode: 'if (inputs.recording !== "Please ship order seven.") throw new Error("Expected the transcribed agent input"); await final("Confirm shipment for order seven without sending it.", { transcript: inputs.recording });' }));
          }
          if (/^## Executor$/m.test(systemText)) {
            assert.equal(stages, 2);
            order.push('executor');
            assert.match(JSON.stringify(request.chatPrompt), /Confirm shipment for order seven without sending it/);
            return chat(JSON.stringify({ javascriptCode: 'if (inputs.distilledContext.transcript !== "Please ship order seven.") throw new Error("Transcript evidence did not reach the executor"); await final("Write the shipment confirmation.", { transcript: inputs.distilledContext.transcript, confirmation: "Order seven is ready to ship." });' }));
          }
          assert.equal(stages, 3);
          order.push('responder');
          assert.match(JSON.stringify(request.chatPrompt), /Order seven is ready to ship/);
          assert.match(JSON.stringify(request.chatPrompt), /Please ship order seven/);
          // Actor code uses its JSON envelope; speech synthesis makes the
          // responder signature textual, with labels rather than a JSON object.
          return chat('Speech: Order seven is ready to ship.\nSummary: Confirm order seven.');
        },
        speechResponse: (request) => { order.push('speak'); assert.equal(request.voice, 'alloy');
          return { data: wav, format: 'wav', transcript: request.text }; },
      });
      // Keep both actor stages explicitly: tool-free agents otherwise default to
      // distiller -> responder and expose respond(), not final(), to the distiller.
      const assistant = agent('recording:audio, question:string -> speech:audio, summary:string', {
        contextFields: [], runtime: new AxJSRuntime(), directResponse: 'off',
        agentIdentity: { name: 'Shipping voice assistant', description: 'Confirms requested shipments without sending them' },
      });
      const result = await assistant.forward(llm, { recording: { data: wav, format: 'wav' }, question: 'What should happen next?' }, {
        ...options(ctx), speech: { transcribe: { language: 'en' }, speak: { voice: 'alloy', format: 'wav' } },
      });
      assert.deepEqual(order, ['transcribe', 'distiller', 'executor', 'responder', 'speak'],
        'Transcription precedes both runtime stages; synthesis follows responder selection');
      assert.equal(result.summary, 'Confirm order seven.');
      assert.equal(result.speech.transcript, 'Order seven is ready to ship.');
      return { summary: result.summary, script: result.speech.transcript, order,
        boundary: 'agent stages see transcripts; use ax/chat for native audio understanding' };
    },
  },
  {
    id: '21-audio/conversation-contract', title: 'Keep conversation audio separate from structured speech artifacts',
    features: ['chat-audio', 'audio-history', 'input-output-independent', 'structured-output-boundary'], modes: ['offline'],
    async run(ctx) {
      const wav = silentWav().toString('base64');
      let requests = 0;
      const llm = ai({ name: 'openai', apiKey: 'fixture-not-a-key', config: axAIOpenAIAudioDefaultConfig(),
        options: { fetch: async (_url, init) => {
          requests++;
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (requests === 1) {
            assert.deepEqual(body.modalities, ['text', 'audio']);
            assert.deepEqual(body.audio, { voice: 'alloy', format: 'wav' });
            assert.match(JSON.stringify(body.messages), /input_audio/);
            assert.ok(!JSON.stringify(body.messages).includes('sampleRate'), 'HTTP input_audio only takes data and format');
          } else {
            assert.equal(body.modalities, undefined, 'Input audio does not require spoken output');
            assert.match(JSON.stringify(body.messages), /previous-turn/);
          }
          return json({ id: 'chat-audio', object: 'chat.completion', created: 0, model: 'gpt-audio-mini',
            choices: [{ index: 0, message: { role: 'assistant', content: null,
              audio: requests === 1 ? { id: 'previous-turn', data: wav, transcript: 'Hello, shipping desk.', expires_at: 2000000000 } : null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        } } });
      const response = await llm.chat({ chatPrompt: [{ role: 'user', content: [
        { type: 'text', text: 'Greet the shipping desk.' },
        { type: 'audio', data: wav, format: 'wav', sampleRate: 24000, channels: 1 },
      ] }] }, { stream: false, abortSignal: ctx.signal });
      assert.ok('results' in response);
      assert.equal(response.results[0]?.audio?.transcript, 'Hello, shipping desk.');
      assert.equal(response.results[0]?.audio?.id, 'previous-turn');
      const textOnly = await llm.chat({ chatPrompt: [
        { role: 'assistant', audio: { id: 'previous-turn' } }, { role: 'user', content: 'Summarize in text only.' },
      ], modelConfig: { audio: { output: { enabled: false } } } }, { stream: false, abortSignal: ctx.signal });
      assert.ok('results' in textOnly);
      await assert.rejects(() => llm.chat({ chatPrompt: [{ role: 'user', content: 'Return JSON and audio.' }],
        responseFormat: { type: 'json_object' } }, { stream: false }), /structured response formats/);
      assert.equal(requests, 2, 'Invalid combinations are rejected before transport');
      return { audioId: response.results[0]?.audio?.id, transcript: response.results[0]?.audio?.transcript,
        selection: 'chat turn + expiring history reference, not signature speech', livePrerequisite: 'OpenAI gpt-audio-mini endpoint access; general text keys/config are not evidence of audio access' };
    },
  },
];
