<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-venn-diagram.svg', alt='Visualize Pages', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-blue-darken-2.animated.fadeInLeft Visualize Pages
            .text-body-large.text-grey.animated.fadeInLeft.wait-p2s Dendrogram representation of your pages
          v-spacer
          v-select.mx-5.animated.fadeInDown.wait-p1s(
            v-if='locales.length > 0'
            v-model='currentLocale'
            :items='locales'
            style='flex: 0 1 120px;'
            variant="solo"
            density="compact"
            hide-details
            item-value='code'
            item-title='name'
          )
          v-btn-toggle.animated.fadeInDown(v-model='graphMode', color='primary', density="compact", rounded)
            v-btn.px-5(value='htree')
              v-icon(start, :color='graphMode === `htree` ? `primary` : `grey-darken-3`') mdi-sitemap
              span.text-none Hierarchical Tree
            v-btn.px-5(value='hradial')
              v-icon(start, :color='graphMode === `hradial` ? `primary` : `grey-darken-3`') mdi-chart-donut-variant
              span.text-none Hierarchical Radial
            v-btn.px-5(value='rradial')
              v-icon(start, :color='graphMode === `rradial` ? `primary` : `grey-darken-3`') mdi-blur-radial
              span.text-none Relational Radial
        .admin-pages-visualize-svg(ref='svgContainer', v-show='pages.length >= 1')
        v-alert(v-if='pages.length < 1', variant="outlined", type='warning', style='max-width: 650px; margin: 0 auto;') Looks like there's no data yet to graph!</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import * as d3 from 'd3'
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
  locales: LocaleOption[]
  currentLocale: string
}

/* global siteConfig, siteLangs */

export default defineComponent({
  data (): AdminPagesVisualizeState {
    return {
      graphMode: 'htree',
      width: 800,
      radius: 400,
      pages: [],
      locales: siteLangs,
      currentLocale: siteConfig.lang
    }
  },
  watch: {
    pages () {
      this.redraw()
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
      wikiStore.startLoading('admin-pages-refresh')
      try {
        this.pages = await fetchPageLinks(
          window.fetch.bind(window),
          this.currentLocale,
          'Page links response is invalid'
        )
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-pages-refresh')
    },
    goToPage (event: MouseEvent, node: d3.HierarchyNode<PageGraphNode>): void {
      const id = node.data.id
      if (id) {
        if (event.ctrlKey || event.metaKey) {
          const { href } = this.$router.resolve(String(id))
          window.open(href, '_blank')
        } else {
          this.$router.push(String(id))
        }
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
        .attr('font-family', 'sans-serif')
        .attr('font-size', 10)
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
        .attr('cursor', 'pointer')
        .text(node => node.data.title)
        .each(function (node: RelationPointNode) {
          node.text = this
        })
        .on('mouseover', overed)
        .on('mouseout', outed)
        .on('click', (event: MouseEvent, node: RelationPointNode) => this.goToPage(event, node))
        .call(text => text.append('title').text(node => `${node.data.path}
          ${node.outgoing.length} outgoing
          ${node.incoming.length} incoming`))
        .clone(true).lower()
        .attr('stroke', 'rgb(var(--v-theme-background))')

      function overed (this: SVGTextElement, _event: MouseEvent, node: RelationPointNode): void {
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

      function outed (this: SVGTextElement, _event: MouseEvent, node: RelationPointNode): void {
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
        .attr('font-family', 'sans-serif')
        .attr('font-size', 10)
        .attr('transform', `translate(${root.dy / 3},${root.dx - x0})`)

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', this.$vuetify.theme.current.dark ? '#999' : '#555')
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

      node.append('circle')
        .attr('fill', descendant => descendant.children ? '#555' : '#999')
        .attr('r', 2.5)

      node.append('text')
        .attr('dy', '0.31em')
        .attr('x', descendant => descendant.children ? -6 : 6)
        .attr('text-anchor', descendant => descendant.children ? 'end' : 'start')
        .attr('fill', this.$vuetify.theme.current.dark ? 'white' : '')
        .attr('cursor', 'pointer')
        .text(descendant => descendant.data.title)
        .on('click', (event: MouseEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .clone(true).lower()
        .attr('stroke', this.$vuetify.theme.current.dark ? '#222' : 'white')

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
        .style('font', '10px sans-serif')

      const g = svg.append('g')

      const zoom = d3.zoom<SVGSVGElement, undefined>()
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
          g.attr('transform', event.transform.toString())
        })
      svg.call(zoom)

      g.append('g')
        .attr('fill', 'none')
        .attr('stroke', this.$vuetify.theme.current.dark ? 'white' : '#555')
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
        .attr('fill', descendant => descendant.children ? '#555' : '#999')
        .attr('r', 2.5)

      node.append('text')
        .attr('dy', '0.31em')

        .attr('x', descendant => descendant.x < Math.PI === !descendant.children ? 6 : -6)
        .attr('text-anchor', descendant => descendant.x < Math.PI === !descendant.children ? 'start' : 'end')
        .attr('transform', descendant => descendant.x >= Math.PI ? 'rotate(180)' : null)

        .attr('fill', this.$vuetify.theme.current.dark ? 'white' : '')
        .attr('cursor', 'pointer')
        .text(descendant => descendant.data.title)
        .on('click', (event: MouseEvent, descendant: d3.HierarchyPointNode<PageGraphNode>) =>
          this.goToPage(event, descendant))
        .clone(true).lower()
        .attr('stroke', this.$vuetify.theme.current.dark ? '#222' : 'white')

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
      const container = this.$refs.svgContainer as HTMLDivElement
      while (container.firstChild) {
        container.firstChild.remove()
      }
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
  }
})
</script>

<style lang='scss'>
.admin-pages-visualize-svg {
  text-align: center;
  // Dynamic viewport - header - title section - footer - content padding
  height: calc(100dvh - 64px - 92px - 32px - 16px);

  > svg {
    height: 100%;
    width: 100%;
  }
}
</style>
