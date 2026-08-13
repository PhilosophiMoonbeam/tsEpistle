import graphHelper from '../../helpers/graph.ts'
import renderingOperations from '../../operations/rendering.ts'

interface RenderersArgs { orderBy?: string | null }
interface UpdateRenderersArgs { renderers: unknown }

const optionalString = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

export default {
  Query: { async rendering () { return {} } },
  Mutation: { async rendering () { return {} } },
  RenderingQuery: {
    async renderers (_obj: unknown, args: RenderersArgs) {
      return renderingOperations.listRenderers(optionalString(args.orderBy))
    }
  },
  RenderingMutation: {
    async updateRenderers (_obj: unknown, args: UpdateRenderersArgs) {
      try {
        await renderingOperations.updateRenderers(args.renderers)
        return { responseResult: graphHelper.generateSuccess('Renderers updated successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
