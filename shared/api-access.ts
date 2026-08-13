export const apiAccessContract = Object.freeze({
  apiKeyTransport: 'graphql',
  bearerScheme: 'Bearer',
  graphqlPath: '/graphql',
  internalRestPrefix: '/_api'
} as const)

export const isInternalRestPath = (path: string): boolean =>
  path === apiAccessContract.internalRestPrefix || path.startsWith(`${apiAccessContract.internalRestPrefix}/`)
