import type { RendererContext, UnknownRecord } from '../../types.ts'
import _ from 'lodash'

interface OpenApiRendererContext extends RendererContext {
  input: string
}

interface ChildRenderer {
  init(input: string, config: UnknownRecord): string | Promise<string>
}

interface ChildRendererModule {
  default: ChildRenderer
}

function isChildRendererModule (value: unknown): value is ChildRendererModule {
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return false
  }
  const renderer = value.default
  return typeof renderer === 'object' &&
    renderer !== null &&
    'init' in renderer &&
    typeof renderer.init === 'function'
}

const plugin = {
  async render (this: OpenApiRendererContext): Promise<string> {
    let output: string = this.input

    for (const child of this.children) {
      // Child renderers are selected from the configured rendering pipeline at runtime.
      const rendererModule: unknown = await import(`../${_.kebabCase(child.key)}/renderer.ts`)
      if (!isChildRendererModule(rendererModule)) {
        throw new TypeError(`Renderer ${child.key} does not export an initializer`)
      }
      output = await rendererModule.default.init(output, child.config)
    }

    return output
  }
}

export default plugin
