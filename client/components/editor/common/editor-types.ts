export interface ContentInsertOptions {
  content: string
}

export interface LineInsertOptions extends ContentInsertOptions {
  newLine?: boolean
}

export interface MultiLineInsertOptions extends ContentInsertOptions {
  after?: string
}

export interface MarkupOptions {
  start: string
  end?: string
}

export interface PageLinkTarget {
  locale: string
  path: string
}
