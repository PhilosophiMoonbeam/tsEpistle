export type VisualMarkdownIssueKind =
  | 'abbreviation'
  | 'attributes'
  | 'diagram'
  | 'footnote'
  | 'highlight'
  | 'html'
  | 'image-size'
  | 'math'
  | 'multiline-table'
  | 'subscript'
  | 'superscript'

export interface VisualMarkdownIssue {
  kind: VisualMarkdownIssueKind
  line: number
  message: string
}

type Check = {
  kind: VisualMarkdownIssueKind
  pattern: RegExp
  message: string
}

const lineChecks: Check[] = [
  {
    kind: 'html',
    pattern: /<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\s*\/?>/,
    message: 'Raw HTML is not supported by Visual Markdown.'
  },
  {
    kind: 'attributes',
    pattern: /\{\s*(?:[#.][A-Za-z]|[^}\n]*(?:\bid\s*=|\bclass\s*=|\btarget\s*=))[^}\n]*\}/,
    message: 'Markdown attributes and custom classes are not supported by Visual Markdown.'
  },
  {
    kind: 'footnote',
    pattern: /\[\^[^\]\n]+\](?::)?/,
    message: 'Footnotes are not supported by Visual Markdown.'
  },
  {
    kind: 'abbreviation',
    pattern: /^\s*\*\[[^\]\n]+\]:/,
    message: 'Abbreviation definitions are not supported by Visual Markdown.'
  },
  {
    kind: 'image-size',
    pattern: /!\[[^\]\n]*\]\([^\n)]*(?:\s=\d*(?:x\d*)?|\s+\d+x\d+)[^\n)]*\)/,
    message: 'Markdown image dimensions are not supported by Visual Markdown.'
  },
  {
    kind: 'math',
    pattern: /\$\$|\\\(|\\\[|\$[^$\n]+\$/,
    message: 'Math syntax is not supported by Visual Markdown.'
  },
  {
    kind: 'highlight',
    pattern: /==[^=\n]+==/,
    message: 'Marked or highlighted text is not supported by Visual Markdown.'
  },
  {
    kind: 'subscript',
    pattern: /(^|[^~])~[^~\n]+~($|[^~])/,
    message: 'Subscript syntax is not supported by Visual Markdown.'
  },
  {
    kind: 'superscript',
    pattern: /\^[^^\s][^^\n]*\^/,
    message: 'Superscript syntax is not supported by Visual Markdown.'
  },
  {
    kind: 'multiline-table',
    pattern: /^\s*\|.*(?:\^\^|\\)\s*\|?\s*$/,
    message: 'Extended multiline or rowspan tables are not supported by Visual Markdown.'
  }
]

const unsupportedFenceLanguages: Record<string, true> = {
  diagram: true,
  kroki: true,
  mermaid: true,
  plantuml: true
}

function stripInlineCode (line: string): string {
  let result = ''
  let index = 0

  while (index < line.length) {
    if (line[index] !== '`') {
      result += line[index]
      index += 1
      continue
    }

    let delimiterEnd = index
    while (line[delimiterEnd] === '`') delimiterEnd += 1
    const delimiter = line.slice(index, delimiterEnd)
    const closingIndex = line.indexOf(delimiter, delimiterEnd)
    if (closingIndex < 0) {
      result += line.slice(index)
      break
    }

    result += ' '.repeat(closingIndex + delimiter.length - index)
    index = closingIndex + delimiter.length
  }

  return result
}

export function findVisualMarkdownIssues (markdown: string): VisualMarkdownIssue[] {
  const issues: VisualMarkdownIssue[] = []
  const lines = markdown.split(/\r?\n/)
  let fence: { marker: '`' | '~', length: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/)
    const fenceToken = fenceMatch?.[1] ?? ''

    if (fence) {
      if (fenceToken.charAt(0) === fence.marker && fenceToken.length >= fence.length) {
        fence = null
      }
      continue
    }

    if (fenceMatch) {
      const language = (fenceMatch[2] ?? '').toLowerCase()
      if (unsupportedFenceLanguages[language]) {
        issues.push({
          kind: 'diagram',
          line: index + 1,
          message: `${language || 'Diagram'} code blocks are not supported by Visual Markdown.`
        })
      }
      fence = {
        marker: fenceToken.charAt(0) as '`' | '~',
        length: fenceToken.length
      }
      continue
    }

    const checkableLine = stripInlineCode(line)
    for (const check of lineChecks) {
      check.pattern.lastIndex = 0
      if (check.pattern.test(checkableLine)) {
        issues.push({
          kind: check.kind,
          line: index + 1,
          message: check.message
        })
      }
    }
  }

  return issues
}

export function findVisualMarkdownIssue (markdown: string): VisualMarkdownIssue | null {
  return findVisualMarkdownIssues(markdown)[0] ?? null
}

export interface VisualMarkdownCapabilityReport {
  compatible: boolean
  issues: VisualMarkdownIssue[]
  sourceEditorRequired: boolean
}

export function inspectVisualMarkdownCapabilities (markdown: string): VisualMarkdownCapabilityReport {
  const issues = findVisualMarkdownIssues(markdown)
  return {
    compatible: issues.length === 0,
    issues,
    sourceEditorRequired: issues.length > 0
  }
}

export function assertVisualMarkdownCompatible (markdown: string): void {
  const issue = findVisualMarkdownIssue(markdown)
  if (issue) {
    throw new Error(`${issue.message} Found on line ${issue.line}. Use the Markdown source editor to preserve this content.`)
  }
}
