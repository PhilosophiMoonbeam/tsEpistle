export const OKF_PRODUCER_CONTEXT = Symbol('okfProducerContext')

export const withOkfProducer = <T extends Record<string, unknown>>(
  input: T,
  producer: string
): T & { readonly [OKF_PRODUCER_CONTEXT]: string } =>
  ({ ...input, [OKF_PRODUCER_CONTEXT]: producer }) as T & { readonly [OKF_PRODUCER_CONTEXT]: string }
