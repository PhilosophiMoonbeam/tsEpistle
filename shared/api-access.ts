export const apiAccessContract = Object.freeze({
  apiKeyTransports: ['graphql', 'rest-v1'],
  bearerScheme: 'Bearer',
  externalRestPrefix: '/api/v1',
  graphqlPath: '/graphql',
  internalRestPrefix: '/_api',
  openApiPath: '/api/v1/openapi.json'
} as const)

export const isInternalRestPath = (path: string): boolean =>
  path === apiAccessContract.internalRestPrefix || path.startsWith(`${apiAccessContract.internalRestPrefix}/`)

export const isExternalRestPath = (path: string): boolean =>
  path === apiAccessContract.externalRestPrefix || path.startsWith(`${apiAccessContract.externalRestPrefix}/`)
