import { readdir } from 'node:fs/promises';
import { isIP, Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { loadEnvFile } from 'node:process';
import {
  ai,
  axResolveAIProfileId,
  AxAIAnthropicModel,
  AxAIAnthropicVertexModel,
  AxAIGoogleGeminiModel,
  AxAIMetaModel,
  AxAIOpenAIModel,
  AxAIOpenAIResponsesModel,
  typesafe,
  type AxAIService,
  type AxAIServiceOptions,
  type AxAITypesafeClient,
} from '@ax-llm/ax';
import type { Example, ExampleContext, ExampleMode } from './support.js';

const HTTP_LIMIT = 50;
const CASE_TIMEOUT_MS = 120_000;

class RunnerError extends Error {}

interface Arguments {
  mode: ExampleMode;
  list: boolean;
  envFile?: string;
  names: string[];
}

function parseArguments(): Arguments {
  const args: Arguments = { mode: 'offline', list: false, names: [] };
  let explicitMode: ExampleMode | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--live' || arg === '--offline') {
      const mode = arg === '--live' ? 'live' : 'offline';
      if (explicitMode && explicitMode !== mode) {
        throw new RunnerError('Choose only one execution mode');
      }
      args.mode = explicitMode = mode;
    } else if (arg === '--env') {
      if (args.envFile || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
        throw new RunnerError('--env requires one explicit path');
      }
      args.envFile = process.argv[++i];
    } else if (arg.startsWith('-')) {
      throw new RunnerError('Unknown command-line option');
    } else args.names.push(arg);
  }
  if (args.mode === 'live' && !args.list && args.names.length === 0) {
    throw new RunnerError('Live execution requires exact case IDs or module basenames');
  }
  return args;
}

function isLoopback(host: string): boolean {
  const plain = host.replace(/^\[|\]$/g, '');
  return plain === '::1' || (isIP(plain) === 4 && plain.startsWith('127.'));
}

/** Live HTTP is invocation-wide; offline fixture HTTP and sockets are case-bounded. */
function networkPolicy(mode: ExampleMode) {
  const originalFetch = globalThis.fetch;
  const originalConnect = Socket.prototype.connect;
  let signal: AbortSignal | undefined;
  let lastCaseSignal: AbortSignal | undefined;
  let requests = 0;
  let caseRequests = 0;
  let modelRequests = 0;
  let loopbackConnections = 0;
  let caseLoopbackConnections = 0;
  const boundedFetch: typeof fetch = async (input, init) => {
    signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new RunnerError('Only credential-free HTTP URLs are permitted');
    }
    if (mode === 'offline' && !isLoopback(url.hostname)) {
      throw new RunnerError('Offline mode denies non-loopback networking');
    }
    if ((mode === 'live' ? requests : caseRequests) >= HTTP_LIMIT) {
      throw new RunnerError(mode === 'live'
        ? 'Invocation HTTP request limit reached'
        : 'Offline case HTTP request limit reached');
    }
    requests++;
    caseRequests++;
    const signals = [signal, init?.signal, input instanceof Request ? input.signal : undefined]
      .filter((item): item is AbortSignal => Boolean(item));
    return originalFetch(input, {
      ...init,
      redirect: 'error',
      signal: signals.length ? AbortSignal.any(signals) : AbortSignal.timeout(CASE_TIMEOUT_MS),
    });
  };
  const modelFetch: typeof fetch = (input, init) => {
    const before = requests;
    const pending = boundedFetch(input, init);
    if (requests > before) modelRequests++;
    return pending;
  };
  // Cover offline node:http, node:https and protocol SDK fixture connections too.
  // Literal IPs avoid DNS rebinding. This is not a third-party socket billing cap.
  if (mode === 'offline') {
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      signal?.throwIfAborted();
      const normalized = Array.isArray(args[0]) ? args[0] as unknown[] : args;
      const first = normalized[0];
      const settings = typeof first === 'object' && first !== null
        ? first as { host?: string; path?: string }
        : undefined;
      const host = settings?.host ?? (typeof normalized[1] === 'string' ? normalized[1] : '127.0.0.1');
      if (settings?.path || (typeof first === 'string' && !/^\d+$/.test(first)) || !isLoopback(host)) {
        throw new RunnerError('Offline mode denies non-loopback sockets');
      }
      if (caseLoopbackConnections >= HTTP_LIMIT) {
        throw new RunnerError('Offline case loopback connection limit reached');
      }
      caseLoopbackConnections++;
      loopbackConnections++;
      return Reflect.apply(originalConnect, this, args);
    } as typeof originalConnect;
    syncBuiltinESMExports();
  }
  globalThis.fetch = boundedFetch;
  return {
    fetch: modelFetch,
    get requests() { return requests; },
    get caseRequests() { return caseRequests; },
    get loopbackConnections() { return loopbackConnections; },
    get caseLoopbackConnections() { return caseLoopbackConnections; },
    get modelRequests() { return modelRequests; },
    setSignal(value: AbortSignal | undefined) {
      if (value && value !== lastCaseSignal) {
        caseRequests = 0;
        caseLoopbackConnections = 0;
        lastCaseSignal = value;
      }
      signal = value;
    },
    restore() {
      globalThis.fetch = originalFetch;
      Socket.prototype.connect = originalConnect;
      syncBuiltinESMExports();
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new RunnerError(`Required environment variable: ${name}`);
  return value;
}

function enumModel<T extends Record<string, string>>(values: T, model: string): T[keyof T] {
  const found = Object.values(values).find((value) => value === model);
  if (!found) {
    throw new RunnerError('Model is not in this provider SDK enum; use a supported model or an explicit deployment profile');
  }
  return found as T[keyof T];
}

function makeService(prefix: 'AI' | 'AI_DECISIONS', settings: AxAIServiceOptions): AxAIService {
  const provider = axResolveAIProfileId(required(`${prefix}_PROVIDER`));
  const model = required(`${prefix}_MODEL`);
  const apiKey = required(`${prefix}_API_KEY`);
  const apiURL = process.env[`${prefix}_API_URL`];
  let service: AxAIService;
  // Do not cast a runtime string to the discriminated ai() argument union.
  // Enum-backed constructors validate their models; deployment profiles accept IDs.
  switch (provider) {
    case 'openai':
      service = ai({ name: provider, apiKey, apiURL,
        config: { model: enumModel(AxAIOpenAIModel, model), maxTokens: 512 } });
      break;
    case 'openai-responses':
      service = ai({ name: provider, apiKey, apiURL,
        config: { model: enumModel(AxAIOpenAIResponsesModel, model), maxTokens: 512 } });
      break;
    case 'anthropic':
      if (apiURL) throw new RunnerError('The anthropic constructor does not accept AI_API_URL');
      service = ai({ name: provider, apiKey,
        config: { model: enumModel({ ...AxAIAnthropicModel, ...AxAIAnthropicVertexModel }, model), maxTokens: 512 } });
      break;
    case 'google-gemini':
      if (apiURL) throw new RunnerError('The google-gemini constructor does not accept AI_API_URL');
      service = ai({ name: provider, apiKey,
        config: { model: enumModel(AxAIGoogleGeminiModel, model), maxTokens: 512 } });
      break;
    case 'meta':
      service = ai({ name: provider, apiKey, apiURL,
        config: { model: enumModel(AxAIMetaModel, model), maxTokens: 512 } });
      break;
    case 'meta-chat':
    case 'meta-messages':
      service = ai({ name: provider, apiKey, apiURL,
        config: { model: enumModel({
          MuseSpark13: AxAIMetaModel.MuseSpark13,
          MuseSpark13Contributor: AxAIMetaModel.MuseSpark13Contributor,
          MuseSpark12: AxAIMetaModel.MuseSpark12,
          MuseSpark12Contributor: AxAIMetaModel.MuseSpark12Contributor,
          MuseSpark11: AxAIMetaModel.MuseSpark11,
        } as const, model), maxTokens: 512 } });
      break;
    case 'typesafe':
    case 'openai-decisions':
      service = ai({ name: provider, apiKey, apiURL, config: { model } });
      break;
    case 'webllm':
    case 'chrome-ai':
      throw new RunnerError('This Node runner requires an HTTP provider, not a browser runtime');
    default:
      service = ai({ name: provider, apiKey, apiURL,
        resourceName: process.env[`${prefix}_RESOURCE_NAME`],
        deploymentName: process.env[`${prefix}_DEPLOYMENT_NAME`],
        version: process.env[`${prefix}_API_VERSION`],
        config: { model, maxTokens: 512 } });
  }
  service.setOptions(settings);
  return service;
}

function context(mode: ExampleMode, signal: AbortSignal, boundedFetch: typeof fetch): ExampleContext {
  let main: AxAIService | undefined;
  let decisions: AxAIService | undefined;
  let native: AxAITypesafeClient | undefined;
  const settings: AxAIServiceOptions = {
    fetch: boundedFetch,
    abortSignal: signal,
    timeout: CASE_TIMEOUT_MS,
    retry: { maxRetries: 1 },
    debug: false,
    verbose: false,
    excludeContentFromTrace: true,
    includeRequestBodyInErrors: false,
    logger: () => {},
  };
  function liveOnly() {
    if (mode !== 'live') throw new RunnerError('Live service access is forbidden in offline mode');
  }
  return {
    mode,
    signal,
    get ai() { liveOnly(); return main ??= makeService('AI', settings); },
    get decisions() { liveOnly(); return decisions ??= makeService('AI_DECISIONS', settings); },
    get nativeDecisions() {
      liveOnly();
      if (axResolveAIProfileId(required('AI_DECISIONS_PROVIDER')) !== 'typesafe') {
        throw new RunnerError('Native decisions require AI_DECISIONS_PROVIDER=typesafe');
      }
      return native ??= typesafe({
        apiKey: required('AI_DECISIONS_API_KEY'),
        model: required('AI_DECISIONS_MODEL'),
        apiURL: process.env.AI_DECISIONS_API_URL,
        options: settings,
      });
    },
  };
}

interface Entry { module: string; example: Example }

async function discover(): Promise<Entry[]> {
  const files = (await readdir(new URL('.', import.meta.url), { withFileTypes: true }))
    .filter((file) => file.isFile() && /^\d{2}-[a-z0-9-]+\.ts$/.test(file.name))
    .map((file) => file.name).sort();
  const entries: Entry[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    // Runtime directory discovery selects plugins; static imports cannot enumerate them.
    const imported: { examples?: unknown } = await import(new URL(file, import.meta.url).href);
    if (!Array.isArray(imported.examples)) throw new RunnerError('Numbered modules must export an examples array');
    for (const candidate of imported.examples) {
      const item = candidate as Partial<Example>;
      if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*$/.test(item.id)
        || !item.id.startsWith(file.slice(0, 3)) || ids.has(item.id)
        || typeof item.title !== 'string' || typeof item.run !== 'function'
        || !Array.isArray(item.features) || !item.features.every((feature) => typeof feature === 'string')
        || !Array.isArray(item.modes) || item.modes.length === 0
        || !item.modes.every((mode) => mode === 'offline' || mode === 'live')) {
        throw new RunnerError('Invalid or duplicate example metadata');
      }
      ids.add(item.id);
      entries.push({ module: file.slice(0, -3), example: item as Example });
    }
  }
  if (entries.length === 0) throw new RunnerError('No numbered examples found');
  return entries;
}

function select(entries: Entry[], args: Arguments): Entry[] {
  if (args.names.length === 0) {
    return args.list ? entries : entries.filter(({ example }) => example.modes.includes(args.mode));
  }
  const selected = new Set<Entry>();
  for (const name of args.names) {
    const matches = entries.filter((entry) => entry.example.id === name || entry.module === name);
    if (!matches.length) throw new RunnerError('Unknown case ID or module basename');
    for (const entry of matches) {
      if (!args.list && !entry.example.modes.includes(args.mode)) {
        throw new RunnerError(`Selected case does not support ${args.mode}: ${entry.example.id}`);
      }
      selected.add(entry);
    }
  }
  return entries.filter((entry) => selected.has(entry));
}

function print(value: unknown): void {
  // Examples return compact, non-secret summaries. Redact configured credentials
  // defensively without printing or retaining request/response bodies.
  const secrets = [process.env.AI_API_KEY, process.env.AI_DECISIONS_API_KEY]
    .filter((item): item is string => Boolean(item));
  const line = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'string') return item;
    return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item);
  });
  if (!line || line.length > 16_384) throw new RunnerError('Example result must be compact JSON');
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const args = parseArguments();
  // Listing is metadata-only: do not load an env file or construct any services.
  if (args.envFile && !args.list) {
    try { loadEnvFile(args.envFile); }
    catch { throw new RunnerError('Could not load the explicit environment file'); }
  }
  const network = networkPolicy(args.list ? 'offline' : args.mode);
  try {
    const entries = select(await discover(), args);
    if (args.list) {
      for (const { module, example } of entries) {
        print({ module, id: example.id, title: example.title, features: example.features, modes: example.modes });
      }
      return;
    }
    for (const { example } of entries) {
      const controller = new AbortController();
      network.setSignal(controller.signal);
      let hardStop: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        controller.abort();
        // Signal-aware SDK calls get a cleanup window. An uncooperative case
        // must not keep the process, network access, or billed work alive.
        hardStop = setTimeout(() => {
          process.stderr.write('{"error":"Case deadline exceeded"}\n');
          process.exit(1);
        }, 1_000);
      }, CASE_TIMEOUT_MS);
      const before = network.modelRequests;
      try {
        const result = await example.run(context(args.mode, controller.signal, network.fetch));
        controller.signal.throwIfAborted();
        print({ id: example.id, mode: args.mode, result: result ?? null,
          modelHTTP: network.modelRequests - before,
          caseHTTP: network.caseRequests, invocationHTTP: network.requests,
          caseLoopbackConnections: network.caseLoopbackConnections,
          invocationLoopbackConnections: network.loopbackConnections });
      } finally {
        clearTimeout(timer);
        clearTimeout(hardStop);
        controller.abort();
        network.setSignal(undefined);
      }
    }
  } finally {
    network.restore();
  }
}

main().catch((error: unknown) => {
  // SDK errors can contain request bodies, URLs and headers. Never dump them.
  const message = error instanceof RunnerError ? error.message : 'Example failed; provider payload and error details withheld';
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
