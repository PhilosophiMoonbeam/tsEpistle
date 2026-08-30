export const apiAccessContract = Object.freeze({
  apiKeyTransports: ['graphql', 'rest-v1'],
  bearerScheme: 'Bearer',
  externalRestPrefix: '/api/v1',
  graphqlPath: '/graphql',
  internalRestPrefix: '/_api',
  mcpPath: '/mcp',
  openApiPath: '/api/v1/openapi.json'
} as const)

export const isInternalRestPath = (path: string): boolean =>
  path === apiAccessContract.internalRestPrefix || path.startsWith(`${apiAccessContract.internalRestPrefix}/`)

export const isExternalRestPath = (path: string): boolean =>
  path === apiAccessContract.externalRestPrefix || path.startsWith(`${apiAccessContract.externalRestPrefix}/`)

export const isApiKeyTransportPath = (path: string): boolean => path === apiAccessContract.graphqlPath || isExternalRestPath(path)
