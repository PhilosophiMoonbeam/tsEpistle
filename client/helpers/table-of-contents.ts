export type TableOfContentsNode = {
  anchor: string
  title: string
  children: TableOfContentsNode[]
}

export type FlattenedTableOfContentsNode = TableOfContentsNode & {
  depth: number
}

export function flattenTableOfContents (
  nodes: TableOfContentsNode[],
  depth = 0
): FlattenedTableOfContentsNode[] {
  return nodes.flatMap(node => [
    { ...node, depth },
    ...flattenTableOfContents(node.children, depth + 1)
  ])
}

/**
 * Keep the two comparative heading levels used by the page sidebar.
 *
 * The server stores headings as a tree whose depth is already normalized to
 * the first two levels present in the document. Keeping this decision here
 * prevents consumers from accidentally displaying deeper implementation
 * detail headings while still preserving the original tree for rendering.
 */
export function normalizeTableOfContents (
  nodes: TableOfContentsNode[]
): FlattenedTableOfContentsNode[] {
  return flattenTableOfContents(nodes).filter(node => node.depth <= 1)
}
