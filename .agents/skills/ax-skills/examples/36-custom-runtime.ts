import assert from 'node:assert/strict';
import {
  agent, f, fn,
  type AxChatResponse, type AxCodeRuntime, type AxCodeSession,
  type AxCodeSessionSnapshot, type AxRuntimeCallableFormatArgs,
  type AxRuntimePrimitiveOverrideMap,
} from '@ax-llm/ax';
import { z } from 'zod';
import { options, scriptedAI, type Example } from './support.js';

// Start here: JSON Plan is an application protocol, NOT Python, JavaScript,
// a general-purpose engine, or an isolation sandbox. There is no eval/Function.
// Only the five operations below exist. Host callbacks run with host authority;
// the application must authorize their inputs/effects and bound their resources.
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const operand = z.union([
  z.string().max(2000), z.number().finite(), z.boolean(), z.null(),
  z.strictObject({ ref: identifier }),
]);
const fields = z.record(identifier, operand);
const planSchema = z.array(z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('read'), path: z.array(identifier).min(2).max(8), as: identifier }),
  z.strictObject({ op: z.literal('sum'), sources: z.array(identifier).min(1).max(32), as: identifier }),
  z.strictObject({ op: z.literal('hostcall'), call: z.string().max(128), args: fields, as: identifier }),
  z.strictObject({ op: z.literal('log'), name: identifier }),
  z.strictObject({ op: z.literal('final'), task: z.string().min(1).max(2000), evidence: fields }),
])).min(1).max(16);
type Operand = z.infer<typeof operand>;
type SessionOptions = Parameters<AxCodeSession['execute']>[1];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Copies data across the protocol boundary; never retains host objects/functions.
// Trusted host inputs/results must be acyclic JSON data, not accessors or classes.
function jsonData(value: unknown, depth = 0): Json {
  if (depth > 16) throw new Error('JSON Plan data nesting exceeds 16');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonData(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).map(key => [key, jsonData(own(value, key), depth + 1)]));
  }
  throw new Error('JSON Plan values must be finite JSON data');
}

function own(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object' || !Object.hasOwn(object, key)) {
    throw new Error(`Missing own property: ${key}`);
  }
  // Own data properties only; never walk prototypes or invoke an accessor.
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) throw new Error(`Not a data property: ${key}`);
  return descriptor.value;
}

class JsonPlanSession implements AxCodeSession {
  private globals: Record<string, unknown>;
  private readonly values = new Map<string, Json>();
  private ended = false;
  get closed(): boolean { return this.ended; }
  get retainedCount(): number { return this.values.size; }

  constructor(
    globals: Record<string, unknown>,
    private readonly allowedCalls: Readonly<Record<string, true | undefined>>,
    private readonly recordFinal: (evidence: Record<string, Json>) => void,
  ) { this.globals = { ...globals }; }

  private check(signal?: AbortSignal): void {
    if (this.ended) throw new Error('JSON Plan session is closed');
    signal?.throwIfAborted();
  }
  private get(name: string): Json {
    if (!this.values.has(name)) throw new Error(`Unknown retained value: ${name}`);
    return this.values.get(name)!;
  }
  private resolve(value: Operand): Json {
    return value !== null && typeof value === 'object' ? jsonData(this.get(value.ref)) : value;
  }
  private resolveFields(input: Record<string, Operand>): Record<string, Json> {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, this.resolve(value)]));
  }
  private set(name: string, value: unknown, reserved: readonly string[] = []): void {
    if (Object.hasOwn(this.globals, name) || reserved.includes(name)) {
      throw new Error(`Cannot overwrite host/reserved binding: ${name}`);
    }
    this.values.set(name, jsonData(value));
  }
  private async call(path: string, args: readonly unknown[]): Promise<unknown> {
    const segments = path.split('.');
    let target: unknown = this.globals;
    for (const segment of segments) target = own(target, segment);
    if (typeof target !== 'function') throw new Error(`Host callable unavailable: ${path}`);
    // These globals are SDK-created closures, not methods requiring a receiver.
    return Reflect.apply(target, undefined, args);
  }

  async execute(code: string, options?: SessionOptions): Promise<unknown> {
    this.check(options?.signal);
    if (code.length > 16_000) throw new Error('JSON Plan source exceeds 16000 characters');
    const plan = planSchema.parse(JSON.parse(code) as unknown);
    if (plan.some(step => step.op === 'final') && plan.length !== 1) {
      throw new Error('final must be the only operation in its turn; inspect on an earlier turn');
    }
    const output: string[] = [];
    // Reject errors unchanged, including host completion/abort signals. Because
    // none are converted into result strings, executeWithStatus is unnecessary.
    for (const step of plan) {
      this.check(options?.signal);
      switch (step.op) {
        case 'read': {
          if (step.path[0] !== 'inputs') throw new Error('read paths must start with inputs');
          let value: unknown = this.globals;
          for (const segment of step.path) value = own(value, segment);
          this.set(step.as, value, options?.reservedNames);
          break;
        }
        case 'sum': {
          let total = 0;
          for (const source of step.sources) {
            const value = this.get(source);
            for (const number of Array.isArray(value) ? value : [value]) {
              if (typeof number !== 'number') throw new Error('sum accepts numbers or flat numeric arrays only');
              total += number;
            }
          }
          this.set(step.as, total, options?.reservedNames);
          break;
        }
        case 'hostcall': {
          if (!Object.hasOwn(this.allowedCalls, step.call) || !this.allowedCalls[step.call]) throw new Error(`Host callable not allowed: ${step.call}`);
          const result = await this.call(step.call, [this.resolveFields(step.args)]);
          this.check(options?.signal);
          this.set(step.as, result, options?.reservedNames);
          break;
        }
        case 'log': output.push(JSON.stringify(this.get(step.name))); break;
        case 'final': {
          const evidence = this.resolveFields(step.evidence);
          this.recordFinal(evidence);
          await this.call('final', [step.task, evidence]);
          break;
        }
      }
    }
    return output.join('\n');
  }

  async snapshotGlobals(options?: SessionOptions): Promise<AxCodeSessionSnapshot> {
    this.check(options?.signal);
    const entries = [...this.values].filter(([name]) => !options?.reservedNames?.includes(name));
    return {
      version: 1,
      entries: entries.map(([name, value]) => ({ name, type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value, preview: JSON.stringify(value).slice(0, 160), restorable: true })),
      bindings: Object.fromEntries(entries.map(([name, value]) => [name, jsonData(value)])),
    };
  }
  async inspectGlobals(options?: SessionOptions): Promise<string> {
    return JSON.stringify((await this.snapshotGlobals(options)).entries);
  }
  async patchGlobals(globals: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<void> {
    this.check(options?.signal);
    // SDK input refresh and phase closures replace existing host globals.
    // Other keys are validated, copied retained data (e.g. restored snapshots).
    for (const [name, value] of Object.entries(globals)) {
      if (Object.hasOwn(this.globals, name)) this.globals[name] = value;
      else this.set(identifier.parse(name), value);
    }
  }
  close(): void {
    this.ended = true;
    this.values.clear();
    this.globals = {};
  }
}

class JsonPlanRuntime implements AxCodeRuntime {
  // Whitespace separates language tokens: 25.4.9 derives jsonPlanCode, NOT
  // javascriptCode (a single token "JSONPlan" would derive jsonplanCode).
  readonly language = 'JSON Plan';
  readonly sessions: JsonPlanSession[] = [];
  readonly completions: Record<string, Json>[] = [];
  private readonly allowedCalls: Readonly<Record<string, true | undefined>> = { 'billing.amounts': true };

  createSession(globals: Record<string, unknown> = {}, _options?: Parameters<AxCodeRuntime['createSession']>[1]): JsonPlanSession {
    // shouldBubbleError needs no filtering here: ALL original errors reject.
    const session = new JsonPlanSession(globals, this.allowedCalls, evidence => {
      this.completions.push(evidence);
    });
    this.sessions.push(session);
    return session;
  }
  getUsageInstructions(): string {
    return [
      'JSON Plan: emit a JSON array in jsonPlanCode; no JS, expressions, loops, imports, or arbitrary calls.',
      'read: {"op":"read","path":["inputs","account"],"as":"account"}; only own input data paths.',
      'hostcall: {"op":"hostcall","call":"billing.amounts","args":{"account":{"ref":"account"}},"as":"amounts"}. Only billing.amounts is allowed.',
      'sum: {"op":"sum","sources":["amounts"],"as":"totalCents"}; sources name retained numbers/flat numeric arrays.',
      'log: {"op":"log","name":"totalCents"}; emits JSON. read/sum/hostcall otherwise produce no output.',
      'args/evidence values are JSON scalars or {"ref":"retainedName"}. Names persist across turns in ONE stage session.',
      'final: [{"op":"final","task":"Report observed invoice total","evidence":{"totalCents":{"ref":"totalCents"}}}]. Must be alone; log observations on earlier turns.',
      'Non-JS stages use separate sessions: pass required values in final evidence; executor reads inputs.distilledContext. No implicit cross-stage bindings.',
      'Maximum 16 operations/16000 source characters; data depth 16. Errors reject; close erases values and host globals.',
      'Other SDK primitives are not exposed by this constrained protocol. Host tools remain privileged; this is not an isolation or resource sandbox.',
    ].join('\n');
  }
  getPrimitiveOverrides(): AxRuntimePrimitiveOverrideMap {
    return {
      final: ['End the stage with a sole JSON Plan final operation: [{"op":"final","task":"...","evidence":{"totalCents":{"ref":"totalCents"}}}].'],
      llmQuery: ['Unavailable in this deliberately constrained JSON Plan protocol.'],
      askClarification: ['Unavailable in this deliberately constrained JSON Plan protocol; the application supplies a complete account input.'],
      inspectRuntime: ['Retained bindings are inspected automatically through this session\'s inspectGlobals/snapshotGlobals methods; no callable inspection operation.'],
    };
  }
  formatCallable(args: AxRuntimeCallableFormatArgs): string {
    return [
      args.description ?? args.qualifiedName,
      JSON.stringify({ op: 'hostcall', call: args.qualifiedName, args: Object.fromEntries(Object.keys(args.parameters?.properties ?? {}).map(name => [name, { ref: name }])), as: 'result' }),
      `Bind parameter values first or replace ref operands with scalar literals. Parameters: ${JSON.stringify(args.parameters)}; returns: ${JSON.stringify(args.returns)}`,
    ].join('\n');
  }
}

const code = (plan: unknown): AxChatResponse => ({ results: [{ index: 0, content: JSON.stringify({ jsonPlanCode: JSON.stringify(plan) }), finishReason: 'stop' }] });

export const examples: readonly Example[] = [
  {
    id: '36-custom-runtime/agent-json-plan',
    title: 'Run an actual agent in a five-operation JSON Plan interpreter, not JavaScript',
    features: ['AxCodeRuntime', 'AxCodeSession', 'language-derived jsonPlanCode', 'getUsageInstructions', 'getPrimitiveOverrides', 'formatCallable', 'host tools', 'persistent values', 'typed final output', 'automatic session cleanup'],
    modes: ['offline'],
    async run(ctx) {
      const runtime = new JsonPlanRuntime();
      const hostCalls: string[] = [];
      // This is real in-process business data and a real SDK host function;
      // only model decisions/responder formatting are scripted, not execution.
      const invoices: Readonly<Record<string, readonly number[] | undefined>> = { ACME: [1250, 2300, 450] };
      const worker = agent('task:string, accountKey:string -> account:string, totalCents:number', {
        runtime, maxTurns: 4, directResponse: 'off', contextPolicy: { preset: 'full' },
        functions: [fn('amounts').namespace('billing').description('Read invoice amounts in integer cents for an account')
          .arg('account', f.string('Account identifier')).returns(f.number('Invoice amount in cents').array())
          .handler(({ account }) => {
            hostCalls.push(account);
            const amounts = Object.hasOwn(invoices, account) ? invoices[account] : undefined;
            if (!amounts) throw new Error(`Unknown account: ${account}`);
            return [...amounts];
          }).build()],
      });
      const responses = [
        code([{ op: 'read', path: ['inputs', 'accountKey'], as: 'selectedAccount' }]),
        code([{ op: 'final', task: 'Fetch invoice amounts for this account and report their sum in cents', evidence: { account: { ref: 'selectedAccount' } } }]),
        code([{ op: 'read', path: ['inputs', 'distilledContext', 'account'], as: 'customer' }, { op: 'hostcall', call: 'billing.amounts', args: { account: { ref: 'customer' } }, as: 'invoiceCents' }, { op: 'log', name: 'invoiceCents' }]),
        code([{ op: 'sum', sources: ['invoiceCents'], as: 'totalCents' }, { op: 'log', name: 'totalCents' }]),
        code([{ op: 'final', task: 'Return the observed account and invoice total in cents', evidence: { account: { ref: 'customer' }, totalCents: { ref: 'totalCents' } } }]),
      ];
      let actorPrompt = '', responderPrompt = '', requests = 0;
      const model = scriptedAI((request, index) => {
        requests++;
        const prompt = JSON.stringify(request.chatPrompt);
        if (index === 0) actorPrompt = prompt;
        const response = responses[index];
        if (response) return response;
        assert.equal(index, responses.length, 'unexpected extra model request');
        responderPrompt = prompt;
        // Explicit offline responder fixture formats the interpreter's REAL
        // final evidence. It does not calculate or invent the business result.
        const evidence = runtime.completions.at(-1);
        assert.ok(evidence && typeof evidence.account === 'string' && typeof evidence.totalCents === 'number');
        assert.match(prompt, new RegExp(String(evidence.totalCents)));
        const content = request.responseFormat
          ? JSON.stringify(evidence)
          : `Account: ${evidence.account}\nTotal Cents: ${evidence.totalCents}`;
        return { results: [{ index: 0, content, finishReason: 'stop' }] };
      }, { structuredOutputs: true });
      const result = await worker.forward(model, { task: 'Report invoice total in integer cents for this account.', accountKey: 'ACME' }, options(ctx));
      assert.deepEqual(result, { account: 'ACME', totalCents: 4000 });
      assert.deepEqual(hostCalls, ['ACME']);
      assert.equal(requests, 6);
      assert.match(actorPrompt, /jsonPlanCode/);
      assert.doesNotMatch(actorPrompt, /javascriptCode/);
      assert.match(actorPrompt, /hostcall/);
      assert.match(actorPrompt, /billing.amounts/);
      assert.match(responderPrompt, /4000/);
      assert.deepEqual(worker.getState()?.runtimeBindings.invoiceCents, [1250, 2300, 450]);
      assert.equal(worker.getState()?.runtimeBindings.totalCents, 4000);
      assert.equal(runtime.sessions.length, 2, 'non-JS distiller/executor have distinct sessions');
      assert.ok(runtime.sessions.every(session => session.closed && session.retainedCount === 0));
      return { result, hostCalls, actorField: 'jsonPlanCode', closedSessions: runtime.sessions.length, proof: 'scripted model I/O; real SDK stages, real host invoice data, interpreter sum over a prior-turn binding, typed responder parse, state export and cleanup' };
    },
  },
  {
    id: '36-custom-runtime/session-lifecycle',
    title: 'Inspect, snapshot, restore and close a custom session; reject unsupported plans',
    features: ['createSession', 'execute', 'patchGlobals', 'inspectGlobals', 'snapshotGlobals', 'fresh session isolation', 'input validation', 'abort signal', 'close'],
    modes: ['offline'],
    async run(ctx) {
      const runtime = new JsonPlanRuntime();
      const first = runtime.createSession({ inputs: { cents: [3, 8] } });
      const fresh = runtime.createSession({ inputs: {} });
      try {
        await first.execute(JSON.stringify([{ op: 'read', path: ['inputs', 'cents'], as: 'cents' }, { op: 'sum', sources: ['cents'], as: 'total' }]), { signal: ctx.signal });
        assert.match(await first.inspectGlobals(), /total/);
        const snapshot = await first.snapshotGlobals();
        assert.equal(snapshot.bindings.total, 11);
        await assert.rejects(() => fresh.execute('[{"op":"log","name":"total"}]'), /Unknown retained value/);
        await fresh.patchGlobals(snapshot.bindings, { signal: ctx.signal });
        assert.equal(await fresh.execute('[{"op":"log","name":"total"}]'), '11');
        await fresh.patchGlobals({ inputs: { cents: [2, 4] } });
        await fresh.execute('[{"op":"read","path":["inputs","cents"],"as":"newCents"},{"op":"sum","sources":["newCents"],"as":"newTotal"}]');
        assert.equal(await fresh.execute('[{"op":"log","name":"newTotal"}]'), '6');
        assert.equal(await fresh.execute('[{"op":"log","name":"total"}]'), '11', 'input refresh preserves retained data');
        await assert.rejects(() => fresh.execute('[{"op":"python","source":"print(1)"}]'));
        await assert.rejects(() => fresh.execute('[{"op":"hostcall","call":"process.exit","args":{},"as":"bad"}]'), /not allowed/);
        await assert.rejects(() => fresh.execute('[{"op":"read","path":["inputs","constructor"],"as":"bad"}]'), /Missing own property/);
        await assert.rejects(() => fresh.execute('[{"op":"log","name":"total"}]', { signal: AbortSignal.abort(new Error('fixture cancellation')) }), /fixture cancellation/);
      } finally { first.close(); fresh.close(); }
      assert.ok(runtime.sessions.every(session => session.closed && session.retainedCount === 0));
      await assert.rejects(() => first.execute('[{"op":"log","name":"total"}]'), /session is closed/);
      return { restoredTotal: 11, refreshedInputTotal: 6, freshSessionsDoNotInheritBindings: true, closedSessions: runtime.sessions.length, boundary: 'bounded structured protocol and explicit host-call allowlist; not a general engine or an isolation/resource sandbox' };
    },
  },
];
