<template>
  <v-container fluid class="pages-atlas">
    <admin-hero :title="$t('admin:pagesVisualize.pageAtlas')" :description="$t('admin:pagesVisualize.seeHowKnowledgeOrganized')" icon="mdi-graph-outline">
      <template #status><dl class="atlas-counts"><div><dt>{{ $t('admin:pagesVisualize.pages', { currentLocale, interpolation: { escapeValue: false } }) }}</dt><dd>{{ pages.length }}</dd></div><div><dt>{{ $t('admin:pagesVisualize.linksWithinView') }}</dt><dd>{{ internalLinkCount }}</dd></div></dl></template>
      <template #actions><v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">{{ $t('admin:pagesVisualize.pageRegister') }}</v-btn><v-btn variant="outlined" prepend-icon="mdi-refresh" :disabled="loading" @click="loadPages">{{ $t('common:actions.refresh') }}</v-btn></template>
    </admin-hero>
    <div class="atlas-controls"><v-select v-model="currentLocale" :items="locales" item-value="code" item-title="name" :label="$t('admin:pagesVisualize.language')" variant="outlined" density="compact" hide-details /><v-btn-toggle v-model="directory" mandatory color="primary" :aria-label="$t('admin:pagesVisualize.atlasView')"><v-btn :value="false">{{ $t('admin:pagesVisualize.diagram') }}</v-btn><v-btn :value="true">{{ $t('admin:pagesVisualize.connectionDirectory') }}</v-btn></v-btn-toggle><v-select v-if="!directory" v-model="graphMode" :items="[{ title: $t('admin:pagesVisualize.folderTree'), value: 'htree' }, { title: $t('admin:pagesVisualize.radialFolders'), value: 'hradial' }, { title: $t('admin:pagesVisualize.pageRelationships'), value: 'rradial' }]" :label="$t('admin:pagesVisualize.diagramStructure')" variant="outlined" density="compact" hide-details /><v-btn v-if="!directory" variant="text" :disabled="loading || !pages.length" @click="fitDiagram">{{ $t('admin:pagesVisualize.resetView') }}</v-btn></div>
    <async-state v-if="loading" state="loading" :title="$t('admin:pagesVisualize.loadingAtlas')" :message="$t('admin:pagesVisualize.fetchingAccessiblePageConnections')" /><async-state v-else-if="errorMessage" state="error" :title="$t('admin:pagesVisualize.atlasCouldNotLoaded')" :message="errorMessage" :retry-label="$t('admin:pagesVisualize.tryAgain')" @retry="loadPages" /><async-state v-else-if="!pages.length" state="empty" :title="$t('admin:pagesVisualize.noPages', { currentLocale, interpolation: { escapeValue: false } })" :message="$t('admin:pagesVisualize.chooseAnotherLanguageReturn')" />
    <template v-else>
      <div v-show="!directory" class="atlas-diagram">
        <p>{{ $t('admin:pagesVisualize.foldersRevealOrganizationPage') }} {{ $t('admin:pagesVisualize.useTabFocusPage', { value: graphMode === 'rradial' ? $t('admin:pagesVisualize.focusPageLabelHighlight3') : $t('admin:pagesVisualize.pageLabelsOpenTheir'), interpolation: { escapeValue: false } }) }}</p>
        <div class="atlas-canvas wiki-surface-well">
        <section ref="svgContainer" class="admin-pages-visualize-svg" :aria-label="$t('admin:pagesVisualize.diagramCanvas')" />
        <fieldset class="atlas-zoom-controls" :aria-label="$t('admin:pagesVisualize.diagramControls')">
          <v-btn variant="text" icon="mdi-magnify-plus-outline" :aria-label="$t('admin:pagesVisualize.zoomIn')" :title="$t('admin:pagesVisualize.zoomIn')" @click="zoomDiagram(1.25)" />
          <v-btn variant="text" icon="mdi-magnify-minus-outline" :aria-label="$t('admin:pagesVisualize.zoomOut')" :title="$t('admin:pagesVisualize.zoomOut')" @click="zoomDiagram(0.8)" />
          <v-btn variant="text" prepend-icon="mdi-fit-to-screen-outline" @click="fitDiagram">{{ $t('admin:pagesVisualize.fitDiagram') }}</v-btn>
        </fieldset>
        </div>
      </div>
      <section v-show="directory" class="atlas-directory" :aria-label="$t('admin:pagesVisualize.pageConnectionDirectory')"><v-text-field v-model="search" :label="$t('admin:pagesVisualize.findPageLinkedPath')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable /><p role="status">{{ $t('admin:pagesVisualize.pages2', { directoryPagesCount: directoryPages.length, interpolation: { escapeValue: false } }) }}</p><article v-for="page in directoryPages" :key="page.id"><div><router-link :to="`/pages/${page.id}`">{{ page.title }}</router-link><code>{{ page.path }}</code></div><div><span>{{ $t('admin:pagesVisualize.outgoingLinksCount', { count: page.links.length }) }}</span><ul v-if="page.links.length"><li v-for="link in page.links" :key="link"><router-link v-if="pages.some(item => item.path === link)" :to="`/pages/${pages.find(item => item.path === link)?.id}`">{{ link }}</router-link><code v-else>{{ link }}</code></li></ul><small v-else>{{ $t('admin:pagesVisualize.noOutgoingPageLinks') }}</small></div></article></section>
    </template>
    <p class="atlas-footnote">{{ $t('admin:pagesVisualize.onlyPagesLinksVisible') }}</p>
  </v-container>
</template>
<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import * as _ from 'lodash-es'
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

type DiagramRuntime = {
  svg: SVGSVGElement
  content: SVGGElement
  zoom: d3.ZoomBehavior<SVGSVGElement, undefined>
  layout: (scale: number) => void
  spacing: number
  fitted: boolean
}

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
  diagram: DiagramRuntime | null
  resizeObserver: ResizeObserver | null
  geometryFrame: number
  disposed: boolean
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
      errorMessage: '',
      diagram: null,
      resizeObserver: null,
      geometryFrame: 0,
      disposed: false
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
    directory () {
      this.$nextTick(() => this.scheduleGeometry())
    },
    currentLocale () {
      this.loadPages()
    }
  },
  methods: {
    scheduleGeometry (): void {
      if (this.disposed || this.geometryFrame) return
      this.geometryFrame = requestAnimationFrame(() => {
        this.geometryFrame = 0
        const container = this.$refs.svgContainer as HTMLElement | undefined
        if (!container || this.directory || !container.clientWidth || !container.clientHeight) return
        if (!this.diagram) this.redraw()
        else this.measureDiagram()
      })
    },
    attachDiagram (
      container: HTMLElement,
      svg: SVGSVGElement,
      content: SVGGElement,
      zoom: d3.ZoomBehavior<SVGSVGElement, undefined>,
      layout: (scale: number) => void
    ): void {
      zoom.duration(0).filter(event => !event.ctrlKey && !event.metaKey && !event.button)
      container.appendChild(svg)
      this.diagram = markRaw({ svg, content, zoom, layout, spacing: 1, fitted: true })
      this.resizeObserver?.disconnect()
      this.resizeObserver?.observe(container)
      this.scheduleGeometry()
    },
    measureDiagram (): void {
      const diagram = this.diagram
      const container = this.$refs.svgContainer as HTMLElement | undefined
      if (!diagram || !container || this.directory || !container.clientWidth || !container.clientHeight) return
      // Measure in the attached SVG's own unzoomed coordinate space. Retain the
      // same text/link elements through font, resize and directory visibility changes.
      const previous = d3.zoomTransform(diagram.svg)
      d3.select<SVGSVGElement, undefined>(diagram.svg).call(diagram.zoom.transform, d3.zoomIdentity)
      const labels = Array.from(diagram.content.querySelectorAll<SVGTextElement>('text:not([aria-hidden="true"])'))
      labels.forEach(label => { label.style.fontWeight = 'bold' })
      diagram.layout(diagram.spacing)
      const boxes = labels.map(label => {
        // Reserve the relationship highlight's bold metrics as well.
        const box = label.getBBox()
        const matrix = label.getCTM()!
        const x = matrix.a * (box.x + box.width / 2) + matrix.c * (box.y + box.height / 2) + matrix.e
        const y = matrix.b * (box.x + box.width / 2) + matrix.d * (box.y + box.height / 2) + matrix.f
        const halfWidth = (Math.abs(matrix.a) * box.width + Math.abs(matrix.c) * box.height) / 2
        const halfHeight = (Math.abs(matrix.b) * box.width + Math.abs(matrix.d) * box.height) / 2
        return {
          x: matrix.e, y: matrix.f,
          left: x - halfWidth, right: x + halfWidth,
          top: y - halfHeight, bottom: y + halfHeight
        }
      })
      labels.forEach(label => { label.style.removeProperty('font-weight') })
      let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity
      let glyphLeft = -3; let glyphRight = 3; let glyphTop = -3; let glyphBottom = 3
      for (const box of boxes) {
        left = Math.min(left, box.x); right = Math.max(right, box.x)
        top = Math.min(top, box.y); bottom = Math.max(bottom, box.y)
        glyphLeft = Math.min(glyphLeft, box.left - box.x); glyphRight = Math.max(glyphRight, box.right - box.x)
        glyphTop = Math.min(glyphTop, box.top - box.y); glyphBottom = Math.max(glyphBottom, box.bottom - box.y)
      }
      const width = Math.max(1, container.clientWidth - 64)
      const height = Math.max(1, container.clientHeight - 64)
      // Bound the fitted content by anchor span + glyph overhang. Solving the
      // gap against both viewport axes reserves six *screen* pixels even when
      // Fit scales down; no iterative render/measure loop is needed.
      const spanX = (right - left) * 6 / width
      const spanY = (bottom - top) * 6 / height
      const overhangX = (glyphRight - glyphLeft) * 6 / width
      const overhangY = (glyphBottom - glyphTop) * 6 / height
      const separation = (distance: number, clearance: number): number => {
        if (distance <= spanX || distance <= spanY) return Infinity
        return Math.max(
          1 + (clearance + 6) / distance,
          (distance + clearance + overhangX) / (distance - spanX),
          (distance + clearance + overhangY) / (distance - spanY)
        )
      }
      let expansion = 1
      // Solve one uniform position expansion analytically. All pairs matter:
      // labels not touching now can cross while their anchors move apart.
      // Glyph sizes stay intrinsic; only positions expand before viewport fit.
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i]
        for (let j = i + 1; j < boxes.length; j++) {
          const b = boxes[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const horizontal = dx > 0 ? separation(dx, a.right - b.left) : dx < 0 ? separation(-dx, b.right - a.left) : Infinity
          const vertical = dy > 0 ? separation(dy, a.bottom - b.top) : dy < 0 ? separation(-dy, b.bottom - a.top) : Infinity
          const required = Math.min(horizontal, vertical)
          const distance = Math.hypot(dx, dy)
          if (Number.isFinite(required)) expansion = Math.max(expansion, required)
          if (distance > 0) expansion = Math.max(expansion, 22 / distance)
        }
      }
      if (expansion > 1) diagram.spacing *= expansion + 0.02
      diagram.layout(diagram.spacing)
      if (diagram.fitted) this.fitDiagram()
      else {
        this.sizeDiagram()
        d3.select<SVGSVGElement, undefined>(diagram.svg).call(diagram.zoom.transform, previous)
      }
    },
    sizeDiagram (): d3.ZoomTransform | null {
      const diagram = this.diagram
      const container = this.$refs.svgContainer as HTMLElement | undefined
      if (!diagram || !container || this.directory || !container.clientWidth || !container.clientHeight) return null
      const width = container.clientWidth
      const height = container.clientHeight
      const bounds = diagram.content.getBBox()
      const scale = Math.min(1, Math.max(1, width - 64) / Math.max(1, bounds.width), Math.max(1, height - 64) / Math.max(1, bounds.height))
      d3.select(diagram.svg).attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`)
      // Large graphs may need less than .25 to fit; user zoom still reaches 8.
      diagram.zoom.extent([[0, 0], [width, height]]).scaleExtent([Math.min(0.25, scale), 8])
      return d3.zoomIdentity.translate(
        (width - bounds.width * scale) / 2 - bounds.x * scale,
        (height - bounds.height * scale) / 2 - bounds.y * scale
      ).scale(scale)
    },
    fitDiagram (): void {
      const diagram = this.diagram
      const fitted = this.sizeDiagram()
      if (!diagram || !fitted) return
      d3.select<SVGSVGElement, undefined>(diagram.svg).interrupt().call(diagram.zoom.transform, fitted)
      diagram.fitted = true
    },
    zoomDiagram (factor: number): void {
      const diagram = this.diagram
      const container = this.$refs.svgContainer as HTMLElement | undefined
      if (!diagram || !container) return
      diagram.fitted = false
      const center: [number, number] = [container.clientWidth / 2, container.clientHeight / 2]
      // Immediate zoom also respects reduced motion without an animation branch.
      d3.select<SVGSVGElement, undefined>(diagram.svg).interrupt().call(diagram.zoom.scaleBy, factor, center)
    },
    async loadPages (): Promise<void> {
      const requestId = ++this.pageLoadRequestId
      this.pageLoadController?.abort()
      const controller = new AbortController()
      this.pageLoadController = controller
      const locale = this.currentLocale

      this.loading = true
      if (this.diagram) d3.select(this.diagram.svg).interrupt().on('.zoom', null)
      this.diagram = null
      this.resizeObserver?.disconnect()
      this.errorMessage = ''
      this.pages = []
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const fetchImpl = window.fetch.bind(window)
        const pages = await fetchPageLinks(
          (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
          locale,
          this.$t('admin:pagesVisualize.pageLinksResponseInvalid')
        )
        if (controller.signal.aborted || requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.pages = markRaw(pages)
      } catch (err) {
        if (controller.signal.aborted || requestId !== this.pageLoadRequestId || locale !== this.currentLocale) {
          return
        }
        this.errorMessage = getErrorMessage(err) || this.$t('admin:pagesVisualize.unableLoadPages')
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
    drawRelations (container: HTMLElement): void {
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
      svg.append('title').text(this.$t('admin:pagesVisualize.interactivePageRelationshipDiagram'))
      svg.append('desc').text(this.$t('admin:pagesVisualize.focusPageLabelHighlight'))

      const gZoom = svg.append('g')
      const g = gZoom.append('g')

      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          if (event.sourceEvent && this.diagram) this.diagram.fitted = false
          gZoom.attr('transform', event.transform.toString())
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
        .attr('class', 'atlas-node')
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
          ? this.$t('admin:pagesVisualize.inspectRelationships', { title: node.data.title, path: node.data.path, interpolation: { escapeValue: false } })
          : this.$t('admin:pagesVisualize.open', { title: node.data.title, path: node.data.path, interpolation: { escapeValue: false } }))
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
        .call(text => text.append('title').text(node => this.$t('admin:pagesVisualize.outgoingIncoming', { path: node.data.path, outgoingCount: node.outgoing.length, incomingCount: node.incoming.length, interpolation: { escapeValue: false } })))
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

      const positions = root.descendants().map(node => ({ node, radius: node.y }))
      this.attachDiagram(container, svg.node()!, g.node()!, zoom, scale => {
        positions.forEach(({ node, radius }) => { node.y = radius * scale })
        g.selectAll<SVGGElement, RelationPointNode>('.atlas-node')
          .attr('transform', node => `rotate(${node.x * 180 / Math.PI - 90}) translate(${node.y},0)`)
        link.attr('d', ([source, target]) => line(source.path(target)))
      })
    },
    /**
     * Hierarchical Tree
     */
    drawTree (container: HTMLElement): void {
      const data = this.hierarchy(this.pages)

      const treeRoot = d3.hierarchy<PageGraphNode>(data) as TreeHierarchyRoot
      treeRoot.dx = 22
      treeRoot.dy = Math.max(160, this.width / (treeRoot.height + 1))
      const root = d3.tree<PageGraphNode>()
        .nodeSize([treeRoot.dx, treeRoot.dy])(treeRoot) as TreePointRoot

      const svg = d3.create('svg')
      svg.append('title').text(this.$t('admin:pagesVisualize.interactivePageHierarchy'))
      svg.append('desc').text(this.$t('admin:pagesVisualize.focusPageLabelHighlight2'))

      // this extra level is necessary because the element that we
      // apply the zoom tranform to must be above the element where
      // we apply the translation (`g`), or else zoom is wonky
      const gZoom = svg.append('g')
      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          if (event.sourceEvent && this.diagram) this.diagram.fitted = false
          gZoom.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      const g = gZoom.append('g')
        .attr('font-family', 'inherit')
        .attr('font-size', 'var(--wiki-font-size-label, 12px)')

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', 'rgb(var(--v-border-color))')
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
          : this.$t('admin:pagesVisualize.open', { title: descendant.data.title, path: descendant.data.path, interpolation: { escapeValue: false } }))
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

      const positions = root.descendants().map(node => ({ node, x: node.x, y: node.y }))
      const horizontal = d3.linkHorizontal<d3.HierarchyPointLink<PageGraphNode>, d3.HierarchyPointNode<PageGraphNode>>()
        .x(node => node.y).y(node => node.x)
      this.attachDiagram(container, svg.node()!, g.node()!, zoom, scale => {
        positions.forEach(({ node, x, y }) => { node.x = x * scale; node.y = y * scale })
        node.attr('transform', descendant => `translate(${descendant.y},${descendant.x})`)
        g.selectAll<SVGPathElement, d3.HierarchyPointLink<PageGraphNode>>('path').attr('d', horizontal)
      })
    },
    /**
     * Hierarchical Radial
     */
    drawRadialTree (container: HTMLElement): void {
      const data = this.hierarchy(this.pages)

      const tree = d3.tree<PageGraphNode>()
        .size([2 * Math.PI, this.radius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth)

      const root = tree(d3.hierarchy<PageGraphNode>(data)
        .sort((a, b) => d3.ascending(a.data.title, b.data.title)))

      const svg = d3.create('svg')
        .style('font-family', 'inherit')
        .style('font-size', 'var(--wiki-font-size-label, 12px)')
      svg.append('title').text(this.$t('admin:pagesVisualize.interactiveRadialPageHierarchy'))
      svg.append('desc').text(this.$t('admin:pagesVisualize.focusPageLabelHighlight2'))

      const gZoom = svg.append('g')
      const g = gZoom.append('g')
      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          if (event.sourceEvent && this.diagram) this.diagram.fitted = false
          gZoom.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', 'rgb(var(--v-border-color))')
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
          : this.$t('admin:pagesVisualize.open', { title: descendant.data.title, path: descendant.data.path, interpolation: { escapeValue: false } }))
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

      const positions = root.descendants().map(node => ({ node, radius: node.y }))
      const radial = d3.linkRadial<d3.HierarchyPointLink<PageGraphNode>, d3.HierarchyPointNode<PageGraphNode>>()
        .angle(node => node.x).radius(node => node.y)
      this.attachDiagram(container, svg.node()!, g.node()!, zoom, scale => {
        positions.forEach(({ node, radius }) => { node.y = radius * scale })
        node.attr('transform', descendant => `rotate(${descendant.x * 180 / Math.PI - 90}) translate(${descendant.y},0)`)
        g.selectAll<SVGPathElement, d3.HierarchyPointLink<PageGraphNode>>('path').attr('d', radial)
      })
    },
    redraw (): void {
      const container = this.$refs.svgContainer as HTMLElement | undefined
      if (!container) {
        return
      }
      this.diagram = null
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
    this.resizeObserver = markRaw(new ResizeObserver(() => this.scheduleGeometry()))
    document.fonts?.addEventListener('loadingdone', this.scheduleGeometry)
    document.fonts?.ready.then(() => this.scheduleGeometry())
    window.addEventListener('resize', this.scheduleGeometry)
    this.loadPages()
  },
  beforeUnmount () {
    this.disposed = true
    cancelAnimationFrame(this.geometryFrame)
    this.resizeObserver?.disconnect()
    document.fonts?.removeEventListener('loadingdone', this.scheduleGeometry)
    window.removeEventListener('resize', this.scheduleGeometry)
    if (this.diagram) d3.select(this.diagram.svg).interrupt().on('.zoom', null)
    this.diagram = null
    this.pageLoadRequestId++
    this.pageLoadController?.abort()
    this.pageLoadController = null
  }
})
</script>

<style scoped lang="scss">
.admin-pages-visualize-svg {
  height: min(65dvh, 48rem);
  min-height: 18rem;
  overflow: hidden;
  text-align: start;
  overscroll-behavior: contain;

  :deep(> svg) {
    display: block;
    max-width: none;
    flex-shrink: 0;
    touch-action: pan-x pan-y pinch-zoom;
  }
  :deep(text:focus-visible) {
    outline: 2px solid rgb(var(--v-theme-primary));
    outline-offset: 3px;
  }
}
.atlas-canvas { padding-bottom: .75rem; }
.atlas-canvas .atlas-zoom-controls { margin-inline-end: .75rem; }
.pages-atlas { max-width: 1600px; padding-bottom: 4rem !important; }
.atlas-counts { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; margin: 0; font-size: .8rem; }
.atlas-counts > div { display: flex; gap: .5rem; align-items: baseline; }
.atlas-counts dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.atlas-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; padding: 1rem 0; }
.atlas-controls .v-select { flex: 1 1 12rem; max-width: 20rem; }
.atlas-diagram, .atlas-directory { border: 1px solid var(--wiki-material-border); border-radius: 12px; background: var(--wiki-surface-gradient); padding: 1rem; }
.atlas-diagram > p, .atlas-footnote { font-size: .8rem; line-height: 1.7; color: rgb(var(--v-theme-on-surface-variant)); }
.atlas-diagram > p { margin-bottom: .75rem; }
.atlas-zoom-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; width: fit-content; max-width: 100%; min-inline-size: 0; padding: 0; margin-block-end: 0; margin-inline-start: auto; margin-top: .75rem; border: 1px solid var(--wiki-material-border); border-radius: 12px; background: var(--wiki-surface-gradient); box-shadow: var(--wiki-specular-border), var(--wiki-shadow-md); }
.atlas-directory > p { padding: 1rem 0; font-size: .8rem; }
.atlas-directory article { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; border-top: 1px solid rgba(var(--v-border-color), .18); padding: 1.4rem 0; }
.atlas-directory article > div { min-width: 0; }
.atlas-directory code { display: block; font-size: .8rem; overflow-wrap: anywhere; margin-top: .4rem; }
.atlas-directory a { color: rgb(var(--v-theme-on-surface)); text-decoration: underline; overflow-wrap: anywhere; }
.atlas-directory ul { padding-inline-start: 1.1rem; margin-top: .6rem; font-size: .8rem; line-height: 1.8; }
.atlas-directory small { display: block; margin-top: .5rem; }
.atlas-footnote { margin: 1.5rem 0; }
.atlas-directory a:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
@media (forced-colors: active) {
  .admin-pages-visualize-svg :deep(text:not([aria-hidden="true"])) { fill: CanvasText !important; }
  .admin-pages-visualize-svg :deep(text[aria-hidden="true"]) { stroke: Canvas !important; }
  .admin-pages-visualize-svg :deep(path[stroke]) { stroke: Highlight !important; stroke-width: 2.5; }
  .admin-pages-visualize-svg :deep(text[font-weight="bold"]) { fill: LinkText !important; }
  .admin-pages-visualize-svg :deep(path) { stroke: CanvasText !important; stroke-opacity: 1; }
  .admin-pages-visualize-svg :deep(circle) { fill: LinkText !important; }
  .admin-pages-visualize-svg :deep(text:focus-visible) { outline-color: Highlight; }
  .atlas-zoom-controls { border-color: ButtonText; background: Canvas; box-shadow: none; }
}
@media (max-width: 600px) {
  .atlas-directory article { grid-template-columns: 1fr; gap: 1rem; }
  .atlas-controls .v-select { max-width: none; }
  .atlas-controls .v-btn-toggle { max-width: 100%; height: auto; flex-wrap: wrap; }
}
</style>
