import { describe, expect, it } from '../bun-test.mts'

import { compareOpenApiCompatibility } from '../../scripts/check-openapi.ts'

describe('OpenAPI compatibility comparison', () => {
  it('rejects making an existing request-body property required', () => {
    const baseline = {
      paths: {
        '/items': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    const current = {
      paths: {
        '/items': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name', 'description'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(compareOpenApiCompatibility(baseline, current)).toEqual([
      'openapi.paths./items.post.requestBody.content.application/json.schema.required now includes existing request property "description"'
    ])
  })

  it.each(['query', 'path', 'header'] as const)('rejects an appended required %s parameter', parameterLocation => {
    const baseline = {
      paths: {
        '/items': {
          get: {
            parameters: []
          }
        }
      }
    }
    const current = {
      paths: {
        '/items': {
          get: {
            parameters: [
              {
                in: parameterLocation,
                name: 'scope',
                required: true,
                schema: { type: 'string' }
              }
            ]
          }
        }
      }
    }

    expect(compareOpenApiCompatibility(baseline, current)).toEqual([
      `openapi.paths./items.get.parameters[0] added required ${parameterLocation} parameter "scope"`
    ])
  })

  it('permits new optional request properties and parameters', () => {
    const baseline = {
      paths: {
        '/items': {
          post: {
            parameters: [{ in: 'query', name: 'locale', schema: { type: 'string' } }],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    }
    const current = {
      paths: {
        '/items': {
          post: {
            parameters: [
              { in: 'query', name: 'locale', schema: { type: 'string' } },
              { in: 'header', name: 'X-Trace', schema: { type: 'string' } }
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(compareOpenApiCompatibility(baseline, current)).toEqual([])
  })

  it('permits additive response fields, including fields required in the response', () => {
    const baseline = {
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id'],
                      properties: { id: { type: 'integer' } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    const current = {
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id', 'summary'],
                      properties: {
                        id: { type: 'integer' },
                        summary: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(compareOpenApiCompatibility(baseline, current)).toEqual([])
  })
})
