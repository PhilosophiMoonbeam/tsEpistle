import {
  AxMockAIService,
  type AxAIService,
  type AxAITypesafeClient,
  type AxChatRequest,
  type AxChatResponse,
  type AxMockAIServiceConfig,
  type AxProgramForwardOptions,
} from '@ax-llm/ax';

export type ExampleMode = 'offline' | 'live';

export interface ExampleContext {
  readonly mode: ExampleMode;
  /** Lazy live services. Access in offline mode is an error, not a fallback. */
  readonly ai: AxAIService;
  readonly decisions: AxAIService;
  readonly nativeDecisions: AxAITypesafeClient;
  readonly signal: AbortSignal;
}

export interface Example {
  readonly id: string;
  readonly title: string;
  readonly features: readonly string[];
  readonly modes: readonly ExampleMode[];
  run(ctx: ExampleContext): Promise<unknown>;
}

type ScriptResult = AxChatResponse | ReadableStream<AxChatResponse>;
type Script = readonly AxChatResponse[] | ((
  request: Readonly<AxChatRequest<unknown>>,
  index: number,
) => ScriptResult | Promise<ScriptResult>);
type FixtureFeatures = AxMockAIServiceConfig<string>['features'];

/** Explicit scripted model I/O; fixtures make no claim about model quality. */
export function scriptedAI(
  responses: Script,
  features: FixtureFeatures = {},
): AxMockAIService<string> {
  let index = 0;
  return new AxMockAIService<string>({
    name: 'offline-script',
    features: {
      functions: true,
      streaming: true,
      structuredOutputs: false,
      ...features,
    },
    options: { debug: false, verbose: false },
    chatResponse: async (request: Readonly<AxChatRequest<unknown>>) => {
      const current = index++;
      if (typeof responses === 'function') return responses(request, current);
      const response = responses[current];
      if (!response) throw new Error('Scripted AI response sequence exhausted');
      return response;
    },
  });
}

export function options(ctx: ExampleContext): AxProgramForwardOptions<string> {
  return {
    maxSteps: 4,
    maxRetries: 1,
    modelConfig: { maxTokens: 512 },
    abortSignal: ctx.signal,
    debug: false,
    verbose: false,
    excludeContentFromTrace: true,
  };
}
