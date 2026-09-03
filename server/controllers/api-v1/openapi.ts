const errorResponse = {
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' }
    }
  },
  description: 'Request failed'
} as const

export const openApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'tsEpistle REST API',
    version: '1.0.0',
    description: 'Versioned external REST API for tsEpistle. Bearer API keys use the permissions and page rules of their assigned group.',
    license: {
      name: 'GNU Affero General Public License v3.0',
      identifier: 'AGPL-3.0-only'
    }
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiDocument',
        security: [],
        responses: {
          '200': {
            description: 'OpenAPI document',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        },
        summary: 'Get this OpenAPI document',
        tags: ['Contract']
      }
    },
    '/pages': {
      get: {
        operationId: 'listPages',
        parameters: [
          { in: 'query', name: 'limit', schema: { default: 50, maximum: 100, minimum: 1, type: 'integer' } },
          { in: 'query', name: 'offset', schema: { default: 0, minimum: 0, type: 'integer' } },
          { in: 'query', name: 'locale', schema: { minLength: 1, type: 'string' } },
          { in: 'query', name: 'tags', description: 'Comma-separated tags; every tag must match.', schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Permission-filtered page list',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PageList' } } }
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '500': errorResponse
        },
        summary: 'List readable pages',
        tags: ['Pages']
      }
    },
    '/pages/{id}': {
      get: {
        operationId: 'getPage',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { minimum: 1, type: 'integer' } }],
        responses: {
          '200': {
            description: 'Readable page metadata',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PageDetail' } } }
          },
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '500': errorResponse
        },
        summary: 'Get readable page metadata',
        tags: ['Pages']
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'tsEpistle API key'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { type: 'string' } }
      },
      PageSummary: {
        type: 'object',
        required: ['id', 'path', 'locale', 'title', 'description', 'isPublished', 'visibility', 'ownerId', 'contentType', 'createdAt', 'updatedAt', 'tags'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          path: { type: 'string' },
          locale: { type: 'string' },
          title: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          isPublished: { type: 'boolean' },
          visibility: { enum: ['public', 'private'] },
          ownerId: { type: ['integer', 'null'] },
          contentType: { type: 'string' },
          createdAt: { type: ['string', 'null'] },
          updatedAt: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string' } }
        }
      },
      PageDetail: {
        allOf: [
          { $ref: '#/components/schemas/PageSummary' },
          {
            type: 'object',
            properties: {
              authorId: { type: ['integer', 'null'] },
              authorName: { type: ['string', 'null'] },
              creatorId: { type: ['integer', 'null'] },
              creatorName: { type: ['string', 'null'] },
              editor: { type: 'string' },
              publishStartDate: { type: ['string', 'null'] },
              publishEndDate: { type: ['string', 'null'] }
            }
          }
        ]
      },
      PageList: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'pagination'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PageSummary' } },
          pagination: {
            type: 'object',
            additionalProperties: false,
            required: ['limit', 'offset', 'nextOffset'],
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              offset: { type: 'integer', minimum: 0 },
              nextOffset: { type: ['integer', 'null'], minimum: 0 }
            }
          }
        }
      }
    }
  }
} as const)
