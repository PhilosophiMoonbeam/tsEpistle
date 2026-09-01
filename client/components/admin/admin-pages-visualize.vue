<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          title='Visualize Pages'
          description='Dendrogram representation of your pages'
          icon='/_assets/svg/icon-venn-diagram.svg'
        )
          template(v-slot:actions)
            .admin-pages-visualize-controls
              v-select.animated.fadeInDown.wait-p1s(
                v-if='locales.length > 0'
                v-model='currentLocale'
                :items='locales'
                label='Locale'
                variant="outlined"
                density="compact"
                hide-details
                item-value='code'
                item-title='name'
              )
              v-btn-toggle.animated.fadeInDown(
                v-model='graphMode'
                color='primary'
                density="compact"
                rounded
                mandatory
                aria-label='Visualization mode'
              )
                v-btn.px-5(value='htree', aria-label='Hierarchical Tree')
                  v-icon(start) mdi-sitemap
                  span.text-none Hierarchical Tree
                v-btn.px-5(value='hradial', aria-label='Hierarchical Radial')
                  v-icon(start) mdi-chart-donut-variant
                  span.text-none Hierarchical Radial
                v-btn.px-5(value='rradial', aria-label='Relational Radial')
                  v-icon(start) mdi-blur-radial
                  span.text-none Relational Radial
        async-state(
          v-if='loading'
          state='loading'
          title='Loading page visualization'
          message='Fetching pages for the selected locale.'
        )
        async-state(
          v-else-if='errorMessage'
          state='error'
          title='Page visualization could not be loaded'
          :message='errorMessage'
          retry-label='Try again'
          @retry='loadPages'
        )
        template(v-else-if='pages.length < 1')
          async-state(
            state='empty'
            :title='`No pages for ${currentLocale}`'
            message='Create a page in this locale or return to Pages.'
          )
          v-btn(to='/pages', color='primary', variant='text') Return to Pages
        .admin-pages-visualize-svg(v-else, ref='svgContainer')

</template>
<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import * as d3 from 'd3'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageLinks, type PageLinkRow } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

type GraphMode = 'htree' | 'hradial' | 'rradial'

type LocaleOption = {
  code: string
  name: string
}

type PageGraphNode = {
  id?: number
  path: string
  title: string
  links: string[]
  children?: PageGraphNode[]
}

type PageBranch = [PageGraphNode, PageLinkRow[]]

interface BilinkHierarchyNode extends d3.HierarchyNode<PageGraphNode> {
  incoming: BilinkRelationship[]
  outgoing: BilinkRelationship[]
}

type BilinkRelationship = [BilinkHierarchyNode, BilinkHierarchyNode]

interface RelationPointNode extends d3.HierarchyPointNode<PageGraphNode> {
  incoming: RelationLink[]
  outgoing: RelationLink[]
  text?: SVGTextElement
}

type RelationLink = [RelationPointNode, RelationPointNode] & {
  path?: SVGPathElement
}

type TreeRootMetadata = {
  dx: number
  dy: number
}

type TreeHierarchyRoot = d3.HierarchyNode<PageGraphNode> & TreeRootMetadata
type TreePointRoot = d3.HierarchyPointNode<PageGraphNode> & TreeRootMetadata

type AdminPagesVisualizeState = {
  graphMode: GraphMode
  width: number
  radius: number
  pages: PageLinkRow[]
  pageLoadRequestId: number
  locales: LocaleOption[]
  currentLocale: string
  loading: boolean
  errorMessage: string
}

/* global siteConfig, siteLangs */

export default defineComponent({
  components: {
    AsyncState
  },
  data (): AdminPagesVisualizeState {
    return {
      graphMode: 'htree',
      width: 800,
      radius: 400,
      pages: [],
      pageLoadRequestId: 0,
      locales: siteLangs,
      currentLocale: siteConfig.lang,
      loading: false,
      errorMessage: ''
    }
  },
  watch: {
    loading: {
      handler (loading: boolean) {
        if (!loading) {
          this.redraw()
        }
      },
      flush: 'post'
    },
    graphMode () {
      this.redraw()
    },
    currentLocale () {
      this.loadPages()
    }
  },
  methods: {
    async loadPages (): Promise<void> {
      const requestId = ++this.pageLoadRequestId
      const locale = this.currentLocale

      this.loading = true
      this.errorMessage = ''
      this.pages = []
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const pages = await fetchPageLinks(
          window.fetch.bind(window),
          locale,
          'Page links response is invalid'
        )
        if (requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.pages = pages
      } catch (err) {
        if (requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.errorMessage = getErrorMessage(err) || 'Unable to load pages.'
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-pages-refresh')
        if (requestId === this.pageLoadRequestId && locale === this.currentLocale) {
          this.loading = false
        }
      }
    },
    goToPage (event: MouseEvent | KeyboardEvent, node: d3.HierarchyNode<PageGraphNode>): void {
      const id = node.data.id
      if (id === undefined) {
        return
      }
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      if (event instanceof KeyboardEvent) {
        event.preventDefault()
      }
      if (event.ctrlKey || event.metaKey) {
        const { href } = this.$router.resolve(String(id))
        window.open(href, '_blank')
      } else {
        this.$router.push(String(id))
      }
    },
    bilink (root: d3.HierarchyNode<PageGraphNode>): BilinkHierarchyNode {
      const nodes = root.descendants() as BilinkHierarchyNode[]
      const map = new Map<string, BilinkHierarchyNode>(
        nodes.map((node): [string, BilinkHierarchyNode] => [node.data.path, node])
      )
      for (const node of nodes) {
        node.incoming = []
        node.outgoing = []
        node.data.links.forEach((path: string) => {
          const relatedNode = map.get(path)
          if (relatedNode) {
            node.outgoing.push([node, relatedNode])
          }
        })
      }
      for (const node of nodes) {
        for (const relationship of node.outgoing) {
          relationship[1].incoming.push(relationship)
        }
      }
      return root as BilinkHierarchyNode
    },
    hierarchy (pages: PageLinkRow[]): PageGraphNode {
      const map = new Map<string, PageLinkRow>(
        pages.map((page): [string, PageLinkRow] => [page.path, page])
      )
      const getPage = (path: string): PageGraphNode => map.get(path) || {
        path,
        title: path.split('/').slice(-1)[0],
        links: []
      }

      function recurse (depth: number, [parent, descendants]: PageBranch): PageGraphNode {
        const truncatePath = (path: string): string => _.take(path.split('/'), depth).join('/')
        const descendantsByChild: PageBranch[] =
          Object.entries(_.groupBy(descendants, page => truncatePath(page.path)))
            .map(([childPath, descendantsGroup]): PageBranch => [
              getPage(childPath),
              _.sortBy(descendantsGroup, child => child.path)
            ])
            .map(([child, descendantsGroup]): PageBranch => [
              child,
              _.filter(descendantsGroup, descendant => descendant.path !== child.path)
            ])
        return {
          ...parent,
          children: descendantsByChild.map(branch => recurse(depth + 1, branch))
        }
      }
      const root: PageGraphNode = {
        path: this.currentLocale,
        title: this.currentLocale,
        links: []
      }
      // start at depth=2 because we're taking {locale} as the root and
      // all paths start with {locale}/
      return recurse(2, [root, pages])
    },
    /**
     * Relational Radial
     */
    drawRelations (): void {
      const data = this.hierarchy(this.pages)

      const line = d3.lineRadial<RelationPointNode>()
        .curve(d3.curveBundle.beta(0.85))
        .radius(node => node.y)
        .angle(node => node.x)

      const tree = d3.cluster<PageGraphNode>()
        .size([2 * Math.PI, this.radius - 100])

      const hierarchyRoot = d3.hierarchy<PageGraphNode>(data)
        .sort((a, b) => d3.ascending(a.height, b.height) || d3.ascending(a.data.path, b.data.path))
      const root = tree(this.bilink(hierarchyRoot)) as RelationPointNode

      const svg = d3.create('svg')
        .attr('viewBox', [-this.width / 2, -this.width / 2, this.width, this.width])
      svg.append('title').text('Interactive page relationship diagram')
      svg.append('desc').text('Focus a page label to highlight incoming and outgoing links. Press Enter or Space to open the page.')

      const g = svg.append('g')

      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          g.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      const link = g.append('g')
        .attr('stroke', 'rgba(var(--v-theme-on-background), .24)')
        .attr('fill', 'none')
        .selectAll<SVGPathElement, RelationLink>('path')
        .data(root.descendants().flatMap(leaf => leaf.outgoing))
        .join('path')
        .attr('d', ([source, target]) => line(source.path(target)))
        .each(function (relationship: RelationLink) {
          relationship.path = this
        })

      g.append('g')
        .attr('font-family', 'inherit')
        .attr('font-size', 'var(--wiki-font-size-label, 12px)')
        .selectAll<SVGGElement, RelationPointNode>('g')
        .data(root.descendants())
        .join('g')
        .attr('transform', node => `rotate(${node.x * 180 / Math.PI - 90}) translate(${node.y},0)`)
        .append('text')
        .attr('dy', '0.31em')
        .attr('x', node => node.x < Math.PI ? 6 : -6)
        .attr('text-anchor', node => node.x < Math.PI ? 'start' : 'end')
        .attr('transform', node => node.x >= Math.PI ? 'rotate(180)' : null)
        .attr('fill', 'rgb(var(--v-theme-on-background))')
        .attr('cursor', node => node.data.id === undefined ? null : 'pointer')
        .attr('tabindex', 0)
        .attr('role', node => node.data.id === undefined ? 'img' : 'link')
        .attr('aria-label', node => node.data.id === undefined
          ? `Inspect relationships for ${node.data.title}, ${node.data.path}`
          : `Open ${node.data.title}, ${node.data.path}`)
        .text(node => node.data.title)
        .each(function (node: RelationPointNode) {
          node.text = this
        })
        .on('mouseover', overed)
        .on('focus', overed)
        .on('mouseout', outed)
        .on('blur', outed)
        .on('click', (event: MouseEvent, node: RelationPointNode) => this.goToPage(event, node))
        .on('keydown', (event: KeyboardEvent, node: RelationPointNode) => this.goToPage(event, node))
        .call(text => text.append('title').text(node => `${node.data.path}
          ${node.outgoing.length} outgoing
          ${node.incoming.length} incoming`))
        .clone(true).lower()
        .attr('aria-hidden', 'true')
        .attr('tabindex', -1)
        .attr('pointer-events', 'none')
        .attr('stroke', 'rgb(var(--v-theme-background))')

      function overed (this: SVGTextElement, _event: Event, node: RelationPointNode): void {
        link.style('mix-blend-mode', null)
        d3.select<SVGTextElement, RelationPointNode>(this).attr('font-weight', 'bold')
        d3.selectAll<SVGPathElement, RelationLink>(
          node.incoming.flatMap(relationship => relationship.path ? [relationship.path] : [])
        ).attr('stroke', 'rgb(var(--v-theme-primary))').raise()
        d3.selectAll<SVGTextElement, RelationPointNode>(
          node.incoming.flatMap(([source]) => source.text ? [source.text] : [])
        ).attr('fill', 'rgb(var(--v-theme-primary))').attr('font-weight', 'bold')
        d3.selectAll<SVGPathElement, RelationLink>(
          node.outgoing.flatMap(relationship => relationship.path ? [relationship.path] : [])
        ).attr('stroke', 'rgb(var(--v-theme-accent))').raise()
        d3.selectAll<SVGTextElement, RelationPointNode>(
          node.outgoing.flatMap(([, target]) => target.text ? [target.text] : [])
        ).attr('fill', 'rgb(var(--v-theme-accent))').attr('font-weight', 'bold')
      }

      function outed (this: SVGTextElement, _event: Event, node: RelationPointNode): void {
        d3.select<SVGTextElement, RelationPointNode>(this).attr('font-weight', null)
        d3.selectAll<SVGPathElement, RelationLink>(
          node.incoming.flatMap(relationship => relationship.path ? [relationship.path] : [])
        ).attr('stroke', null)
        d3.selectAll<SVGTextElement, RelationPointNode>(
          node.incoming.flatMap(([source]) => source.text ? [source.text] : [])
        ).attr('fill', null).attr('font-weight', null)
        d3.selectAll<SVGPathElement, RelationLink>(
          node.outgoing.flatMap(relationship => relationship.path ? [relationship.path] : [])
        ).attr('stroke', null)
        d3.selectAll<SVGTextElement, RelationPointNode>(
          node.outgoing.flatMap(([, target]) => target.text ? [target.text] : [])
        ).attr('fill', null).attr('font-weight', null)
      }

      const svgNode = svg.node()
      if (svgNode) {
        const container = this.$refs.svgContainer as HTMLDivElement
        container.appendChild(svgNode)
      }
    },
    /**
     * Hierarchical Tree
     */
    drawTree (): void {
      const data = this.hierarchy(this.pages)

      const treeRoot = d3.hierarchy<PageGraphNode>(data) as TreeHierarchyRoot
      treeRoot.dx = 10
      treeRoot.dy = this.width / (treeRoot.height + 1)
      const root = d3.tree<PageGraphNode>()
        .nodeSize([treeRoot.dx, treeRoot.dy])(treeRoot) as TreePointRoot

      let x0 = Infinity
      let x1 = -x0
      root.each(node => {
        if (node.x > x1) x1 = node.x
        if (node.x < x0) x0 = node.x
      })

      const svg = d3.create('svg')
        .attr('viewBox', [0, 0, this.width, x1 - x0 + root.dx * 2])
      svg.append('title').text('Interactive page hierarchy')
      svg.append('desc').text('Focus a page label to highlight related links. Press Enter or Space to open the page.')

      // this extra level is necessary because the element that we
      // apply the zoom tranform to must be above the element where
      // we apply the translation (`g`), or else zoom is wonky
      const gZoom = svg.append('g')
      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          gZoom.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      const g = gZoom.append('g')
        .attr('font-family', 'inherit')
        .attr('font-size', 'var(--wiki-font-size-label, 12px)')
        .attr('transform', `translate(${root.dy / 3},${root.dx - x0})`)

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', 'rgb(var(--v-theme-border))')
        .attr('stroke-opacity', 0.4)
        .attr('stroke-width', 1.5)
        .selectAll<SVGPathElement, d3.HierarchyPointLink<PageGraphNode>>('path')
        .data(root.links())
        .join('path')
        .attr('d', d3.linkHorizontal<
          d3.HierarchyPointLink<PageGraphNode>,
          d3.HierarchyPointNode<PageGraphNode>
        >()
          .x(node => node.y)
          .y(node => node.x))

      const node = g.append('g')
        .attr('stroke-linejoin', 'round')
        .attr('stroke-width', 3)
        .selectAll<SVGGElement, d3.HierarchyPointNode<PageGraphNode>>('g')
        .data(root.descendants())
        .join('g')
        .attr('transform', descendant => `translate(${descendant.y},${descendant.x})`)
      node.append('text')
        .attr('dy', '0.31em')
        .attr('x', descendant => descendant.children ? -6 : 6)
        .attr('text-anchor', descendant => descendant.children ? 'end' : 'start')
        .attr('fill', 'rgb(var(--v-theme-on-background))')
        .attr('cursor', descendant => descendant.data.id === undefined ? null : 'pointer')
        .attr('tabindex', descendant => descendant.data.id === undefined ? null : 0)
        .attr('role', descendant => descendant.data.id === undefined ? null : 'link')
        .attr('aria-label', descendant => descendant.data.id === undefined
          ? null
          : `Open ${descendant.data.title}, ${descendant.data.path}`)
        .text(descendant => descendant.data.title)
        .on('click', (event: MouseEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .on('keydown', (event: KeyboardEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .call(text => text.append('title').text(descendant => descendant.data.path))
        .clone(true).lower()
        .attr('aria-hidden', 'true')
        .attr('tabindex', -1)
        .attr('pointer-events', 'none')
        .attr('stroke', 'rgb(var(--v-theme-background))')

      const svgNode = svg.node()
      if (svgNode) {
        const container = this.$refs.svgContainer as HTMLDivElement
        container.appendChild(svgNode)
      }
    },
    /**
     * Hierarchical Radial
     */
    drawRadialTree (): void {
      const data = this.hierarchy(this.pages)

      const tree = d3.tree<PageGraphNode>()
        .size([2 * Math.PI, this.radius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth)

      const root = tree(d3.hierarchy<PageGraphNode>(data)
        .sort((a, b) => d3.ascending(a.data.title, b.data.title)))

      const svg = d3.create('svg')
        .style('font-family', 'inherit')
        .style('font-size', 'var(--wiki-font-size-label, 12px)')
      svg.append('title').text('Interactive radial page hierarchy')
      svg.append('desc').text('Focus a page label to highlight related links. Press Enter or Space to open the page.')

      const g = svg.append('g')
      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          g.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', 'rgb(var(--v-theme-border))')
        .attr('stroke-opacity', 0.4)
        .attr('stroke-width', 1.5)
        .selectAll<SVGPathElement, d3.HierarchyPointLink<PageGraphNode>>('path')
        .data(root.links())
        .join('path')
        .attr('d', d3.linkRadial<
          d3.HierarchyPointLink<PageGraphNode>,
          d3.HierarchyPointNode<PageGraphNode>
        >()
          .angle(node => node.x)
          .radius(node => node.y))

      const node = g.append('g')
        .attr('stroke-linejoin', 'round')
        .attr('stroke-width', 3)
        .selectAll<SVGGElement, d3.HierarchyPointNode<PageGraphNode>>('g')
        .data(root.descendants().reverse())
        .join('g')
        .attr('transform', descendant => `
          rotate(${descendant.x * 180 / Math.PI - 90})
          translate(${descendant.y},0)
        `)

      node.append('circle')
        .attr('fill', descendant => descendant.children ? 'rgb(var(--v-theme-primary))' : 'rgb(var(--v-theme-accent))')
        .attr('r', 2.5)

      node.append('text')
        .attr('dy', '0.31em')
        .attr('x', descendant => descendant.x < Math.PI === !descendant.children ? 6 : -6)
        .attr('text-anchor', descendant => descendant.x < Math.PI === !descendant.children ? 'start' : 'end')
        .attr('transform', descendant => descendant.x >= Math.PI ? 'rotate(180)' : null)
        .attr('fill', 'rgb(var(--v-theme-on-background))')
        .attr('cursor', descendant => descendant.data.id === undefined ? null : 'pointer')
        .attr('tabindex', descendant => descendant.data.id === undefined ? null : 0)
        .attr('role', descendant => descendant.data.id === undefined ? null : 'link')
        .attr('aria-label', descendant => descendant.data.id === undefined
          ? null
          : `Open ${descendant.data.title}, ${descendant.data.path}`)
        .text(descendant => descendant.data.title)
        .on('click', (event: MouseEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .on('keydown', (event: KeyboardEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .call(text => text.append('title').text(descendant => descendant.data.path))
        .clone(true).lower()
        .attr('aria-hidden', 'true')
        .attr('tabindex', -1)
        .attr('pointer-events', 'none')
        .attr('stroke', 'rgb(var(--v-theme-background))')

      const svgNode = svg.node()
      if (svgNode) {
        const container = this.$refs.svgContainer as HTMLDivElement
        container.appendChild(svgNode)
      }

      function autoBox (this: SVGSVGElement): [number, number, number, number] {
        const { x, y, width, height } = this.getBBox()
        return [x, y, width, height]
      }

      svg.attr('viewBox', autoBox)
    },
    redraw (): void {
      const container = this.$refs.svgContainer as HTMLDivElement | undefined
      if (!container) {
        return
      }
      container.replaceChildren()
      if (this.pages.length > 0) {
        switch (this.graphMode) {
          case 'rradial':
            this.drawRelations()
            break
          case 'htree':
            this.drawTree()
            break
          case 'hradial':
            this.drawRadialTree()
            break
        }
      }
    }
  },
  mounted () {
    this.loadPages()
  },
  beforeUnmount () {
    this.pageLoadRequestId++
  }
})
</script>

<style lang='scss'>
.admin-pages-visualize-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin: 1rem 0;
}

.admin-pages-visualize-controls .v-select {
  flex: 0 1 14rem;
  min-width: 10rem;
}

.admin-pages-visualize-svg {
  display: flex;
  min-height: min(65dvh, 48rem);
  text-align: center;
  overflow: hidden;

  > svg {
    height: 100%;
    min-height: inherit;
    width: 100%;
  }
}

@media (max-width: 599.98px) {
  .admin-pages-visualize-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .admin-pages-visualize-controls .v-select,
  .admin-pages-visualize-controls .v-btn-toggle {
    width: 100%;
  }

  .admin-pages-visualize-controls .v-btn-toggle {
    overflow-x: auto;
    justify-content: flex-start;
  }

  .admin-pages-visualize-controls .v-btn {
    flex: 1 0 auto;
  }
}
</style>
