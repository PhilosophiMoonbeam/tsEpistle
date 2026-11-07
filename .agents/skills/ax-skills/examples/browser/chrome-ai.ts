import { ai, ax, type AxAIChromeAIArgs } from '@ax-llm/ax';

// Minimal local browser shapes keep the Node example collection free of DOM globals.
// These are host capabilities, not replacement implementations or a model fixture.
type BrowserLanguageModel = NonNullable<AxAIChromeAIArgs['languageModel']>;
interface Control {
  textContent: string | null;
  value: string;
  disabled: boolean;
  addEventListener(event: 'click', listener: () => void): void;
}
const host = globalThis as unknown as {
  isSecureContext?: boolean;
  LanguageModel?: BrowserLanguageModel;
  ai?: { languageModel?: BrowserLanguageModel };
  document: { getElementById(id: string): Control | null };
  addEventListener(event: 'pagehide', listener: () => void): void;
};
function control(id: string) {
  const element = host.document.getElementById(id);
  if (!element) throw new Error(`Missing demo element: ${id}`);
  return element;
}
const status = control('status');
const capability = control('capability');
const output = control('output');
const question = control('question');
const answerButton = control('answer');
const streamButton = control('stream');
const cancelButton = control('cancel');
const refreshButton = control('refresh');
let active: AbortController | undefined;
let usable = false;

function buttons() {
  answerButton.disabled = !usable || active !== undefined;
  streamButton.disabled = !usable || active !== undefined;
  refreshButton.disabled = active !== undefined;
  cancelButton.disabled = active === undefined;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

// availability()/capabilities() only inspect state. No create(), provider construction,
// model download, remote inference or fallback occurs when this module is imported.
async function inspect() {
  usable = false;
  buttons();
  try {
    if (!host.isSecureContext) {
      capability.textContent = 'Unavailable: serve this page on localhost or HTTPS (a secure context).';
      return;
    }
    const model = host.LanguageModel ?? host.ai?.languageModel;
    if (!model) {
      capability.textContent = 'Unavailable: this browser does not expose LanguageModel. Use a supported desktop Chrome with the Prompt API enabled and eligible hardware/profile. No browser model was exercised.';
      return;
    }
    const availability = model.availability
      ? await model.availability()
      : (await model.capabilities?.())?.available;
    if (availability === 'unavailable' || availability === 'no') {
      capability.textContent = 'Unavailable on this device/profile. Check Chrome hardware, storage and Prompt API prerequisites. No browser model was exercised.';
      return;
    }
    usable = true;
    if (availability === 'downloadable' || availability === 'after-download') {
      capability.textContent = 'Model downloadable. Clicking Answer or Stream authorizes Chrome to download its local model, then run the question. Initial download requires network access and may take time; no cloud fallback exists.';
    } else if (availability === 'downloading') {
      capability.textContent = 'Chrome is downloading the local model. A request may wait for it. Cancel remains available; this Ax adapter does not expose download-progress monitoring.';
    } else if (availability === 'available' || availability === 'readily') {
      capability.textContent = 'Chrome reports the local model available. Click Answer to run Ax with native JSON Schema, or Stream to inspect successive text chunks.';
    } else {
      capability.textContent = 'LanguageModel exists, but this browser exposes no recognized availability state. Click to attempt the real SDK; success is not assumed.';
    }
  } catch (error) {
    capability.textContent = `Capability check failed: ${errorMessage(error)}. No browser model was exercised.`;
  } finally { buttons(); }
}

async function run(mode: 'answer' | 'stream') {
  if (active || !usable) return;
  const text = question.value.trim();
  if (!text) { status.textContent = 'Enter an English question first.'; return; }
  const controller = new AbortController();
  active = controller;
  buttons();
  output.textContent = '';
  status.textContent = 'Starting local inference (or waiting for Chrome’s model download)…';
  try {
    // This is the actual public SDK path, reached only by a user button click.
    // Omit temperature/topK: ordinary web pages use Chrome defaults, not extension settings.
    const llm = ai({ name: 'chrome-ai' });
    if (mode === 'answer') {
      const program = ax('question:string "A short factual question in English" -> answer:string "A concise answer in English"');
      const result = await program.forward(llm, { question: text }, {
        stream: false,
        structuredOutputMode: 'native',
        abortSignal: controller.signal,
        maxRetries: 0,
        maxSteps: 1,
        debug: false,
        verbose: false,
        excludeContentFromTrace: true,
      });
      output.textContent = result.answer;
      status.textContent = 'Answer complete. Ax parsed the schema-constrained response and released the request’s session. Verify factual claims yourself.';
    } else {
      const response = await llm.chat({ chatPrompt: [
        { role: 'system', content: 'Answer in English. Keep the answer concise.' },
        { role: 'user', content: text },
      ] }, { stream: true, abortSignal: controller.signal });
      if (!(response instanceof ReadableStream)) throw new Error('Expected a streaming Chrome response');
      const reader = response.getReader();
      let count = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          // The provider passes native successive text unchanged. Show explicit boundaries:
          // do not guess cumulative-vs-delta behavior or trim overlapping characters.
          for (const result of chunk.value.results) {
            if (result.content !== undefined) {
              output.textContent = `${output.textContent ?? ''}Chunk ${++count}:\n${result.content}\n\n`;
            }
          }
          status.textContent = `Streaming local text: ${count} chunk(s). Output is provisional until completion.`;
        }
      } finally { reader.releaseLock(); }
      status.textContent = 'Stream complete. Native successive chunks are shown verbatim; Ax released the session.';
    }
  } catch (error) {
    status.textContent = controller.signal.aborted
      ? 'Cancelled. Partial output is not a completed answer; Ax releases the created session.'
      : `Request failed: ${errorMessage(error)}. No network/model fallback was attempted. Ax cleans up sessions created before a prompt failure.`;
  } finally {
    // Signals reach both session creation and prompting. Abort also covers an interrupted
    // stream (including navigation); reader cancellation alone is not the browser contract.
    controller.abort();
    active = undefined;
    buttons();
  }
}
answerButton.addEventListener('click', () => { void run('answer'); });
streamButton.addEventListener('click', () => { void run('stream'); });
cancelButton.addEventListener('click', () => { active?.abort(); });
refreshButton.addEventListener('click', () => { void inspect(); });
host.addEventListener('pagehide', () => { active?.abort(); });
status.textContent = 'Browser entry loaded. Capability inspection does not start a model download.';
void inspect();
