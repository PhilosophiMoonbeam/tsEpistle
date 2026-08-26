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
