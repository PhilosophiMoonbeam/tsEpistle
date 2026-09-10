<template>
  <v-container fluid class="pages-atlas">
    <admin-hero title="Page atlas" description="See how knowledge is organized and connected." icon="mdi-graph-outline"><template #actions><v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">Page register</v-btn><v-btn variant="outlined" prepend-icon="mdi-refresh" :disabled="loading" @click="loadPages">Refresh</v-btn></template></admin-hero>
    <section class="atlas-intro"><div><span class="atlas-kicker">Structure &amp; relationships</span><h2>Follow the shape of your knowledge.</h2><p>Folders reveal organization. Page links reveal connections. Explore a diagram or use the searchable connection directory.</p></div><dl><div><dt>Pages in {{ currentLocale }}</dt><dd>{{ pages.length }}</dd></div><div><dt>Links within this view</dt><dd>{{ internalLinkCount }}</dd></div></dl></section>
    <div class="atlas-controls"><v-select v-model="currentLocale" :items="locales" item-value="code" item-title="name" label="Language" variant="outlined" density="compact" hide-details /><v-btn-toggle v-model="directory" mandatory color="primary" aria-label="Atlas view"><v-btn :value="false">Diagram</v-btn><v-btn :value="true">Connection directory</v-btn></v-btn-toggle><v-select v-if="!directory" v-model="graphMode" :items="[{ title: 'Folder tree', value: 'htree' }, { title: 'Radial folders', value: 'hradial' }, { title: 'Page relationships', value: 'rradial' }]" label="Diagram structure" variant="outlined" density="compact" hide-details /><v-btn v-if="!directory" variant="text" :disabled="loading" @click="redraw">Reset view</v-btn></div>
    <async-state v-if="loading" state="loading" title="Loading the atlas" message="Fetching accessible page connections." /><async-state v-else-if="errorMessage" state="error" title="The atlas could not be loaded" :message="errorMessage" retry-label="Try again" @retry="loadPages" /><async-state v-else-if="!pages.length" state="empty" :title="`No pages for ${currentLocale}`" message="Choose another language or return to the page register." />
    <template v-else><div v-show="!directory" class="atlas-diagram"><p>{{ graphMode === 'rradial' ? 'Focus a page label to highlight its incoming and outgoing links. Drag to pan and scroll to zoom.' : 'Page labels open their administration details. Folder nodes organize paths and do not represent pages.' }} Use Tab to focus a page, then Enter to open it.</p><div ref="svgContainer" class="admin-pages-visualize-svg" /></div><section v-show="directory" class="atlas-directory" aria-label="Page connection directory"><v-text-field v-model="search" label="Find a page or linked path" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable /><p role="status">{{ directoryPages.length }} pages</p><article v-for="page in directoryPages" :key="page.id"><div><router-link :to="`/pages/${page.id}`">{{ page.title }}</router-link><code>{{ page.path }}</code></div><div><span>{{ page.links.length }} {{ page.links.length === 1 ? 'outgoing link' : 'outgoing links' }}</span><ul v-if="page.links.length"><li v-for="link in page.links" :key="link"><router-link v-if="pages.some(item => item.path === link)" :to="`/pages/${pages.find(item => item.path === link)?.id}`">{{ link }}</router-link><code v-else>{{ link }}</code></li></ul><small v-else>No outgoing page links recorded.</small></div></article></section></template>
    <p class="atlas-footnote">Only pages and links visible to your account are included. A linked path outside this view may belong to another language or a page you cannot access; this view does not infer whether it exists.</p>
  </v-container>
</template>
<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
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
  directory: boolean
  search: string
  width: number
  radius: number
  pages: PageLinkRow[]
  pageLoadRequestId: number
  pageLoadController: AbortController | null
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
      directory: false,
      search: '',
      width: 800,
      radius: 400,
      pages: [],
      pageLoadRequestId: 0,
      pageLoadController: null,
      locales: markRaw(siteLangs),
      currentLocale: siteConfig.lang,
      loading: false,
      errorMessage: ''
    }
  },
  computed: {
    directoryPages(): PageLinkRow[] { const term = (this.search || '').trim().toLocaleLowerCase(); return this.pages.filter(page => !term || [page.title, page.path, ...page.links].some(value => value.toLocaleLowerCase().includes(term))) },
    internalLinkCount(): number { const paths = new Set(this.pages.map(page => page.path)); return this.pages.reduce((count, page) => count + page.links.filter(path => paths.has(path)).length, 0) }
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
      this.pageLoadController?.abort()
      const controller = new AbortController()
      this.pageLoadController = controller
      const locale = this.currentLocale

      this.loading = true
      this.errorMessage = ''
      this.pages = []
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const fetchImpl = window.fetch.bind(window)
        const pages = await fetchPageLinks(
          (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
          locale,
          'Page links response is invalid'
        )
        if (controller.signal.aborted || requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.pages = markRaw(pages)
      } catch (err) {
        if (controller.signal.aborted || requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.errorMessage = getErrorMessage(err) || 'Unable to load pages.'
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-pages-refresh')
        if (this.pageLoadController === controller) {
          this.pageLoadController = null
          if (requestId === this.pageLoadRequestId && locale === this.currentLocale) {
            this.loading = false
          }
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
        const { href } = this.$router.resolve(`/pages/${id}`)
        window.open(href, '_blank', 'noopener')
      } else {
        this.$router.push(`/pages/${id}`)
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
    drawRelations (container: HTMLDivElement): void {
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
        container.appendChild(svgNode)
      }
    },
    /**
     * Hierarchical Tree
     */
    drawTree (container: HTMLDivElement): void {
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
        container.appendChild(svgNode)
      }
    },
    /**
     * Hierarchical Radial
     */
    drawRadialTree (container: HTMLDivElement): void {
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
            this.drawRelations(container)
            break
          case 'htree':
            this.drawTree(container)
            break
          case 'hradial':
            this.drawRadialTree(container)
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
    this.pageLoadController?.abort()
    this.pageLoadController = null
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
<style scoped lang="scss">
.pages-atlas { max-width:1600px; padding-bottom:4rem !important; }.atlas-intro { display:flex; align-items:center; justify-content:space-between; gap:3rem; padding:2rem .5rem; }.atlas-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.13em; }h2 { font:500 clamp(1.7rem,2.5vw,2.5rem)/1.15 var(--font-family-serif,Georgia,serif); margin:.7rem 0 1rem; }.atlas-intro p { line-height:1.7; max-width:45rem; color:rgb(var(--v-theme-on-surface-variant)); }.atlas-intro dl { display:flex; flex-shrink:0; gap:2rem; }.atlas-intro dt { font-size:.75rem; }.atlas-intro dd { font:500 2.2rem Georgia,serif; margin:.4rem 0 0; }.atlas-controls { display:flex; flex-wrap:wrap; align-items:center; gap:1rem; padding:1rem 0; }.atlas-controls .v-select { flex:1 1 12rem; max-width:20rem; }.atlas-diagram,.atlas-directory { border:1px solid rgba(var(--v-border-color),.18); border-radius:12px; background:rgb(var(--v-theme-surface)); padding:1.5rem; }.atlas-diagram>p,.atlas-footnote { font-size:.8rem; line-height:1.7; color:rgb(var(--v-theme-on-surface-variant)); }.atlas-directory>p { padding:1rem 0; font-size:.8rem; }.atlas-directory article { display:grid; grid-template-columns:1fr 1fr; gap:2rem; border-top:1px solid rgba(var(--v-border-color),.18); padding:1.4rem 0; }.atlas-directory article>div { min-width:0; }.atlas-directory code { display:block; font-size:.8rem; overflow-wrap:anywhere; margin-top:.4rem; }.atlas-directory a { color:rgb(var(--v-theme-on-surface)); text-decoration:underline; overflow-wrap:anywhere; }.atlas-directory ul { padding-left:1.1rem; margin-top:.6rem; font-size:.8rem; line-height:1.8; }.atlas-directory small { display:block; margin-top:.5rem; }.atlas-footnote { margin:1.5rem 0; }.atlas-directory a:focus-visible { outline:2px solid rgb(var(--v-theme-primary)); outline-offset:3px; }@media(max-width:900px) { .atlas-intro { align-items:start; flex-direction:column; gap:1.5rem; } }@media(max-width:600px) { .atlas-directory article { grid-template-columns:1fr; gap:1rem; }.atlas-controls .v-select { max-width:none; }.atlas-diagram,.atlas-directory { padding:1rem; } }
</style>
