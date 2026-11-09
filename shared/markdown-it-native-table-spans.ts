import type { MarkdownIt, StateCore, Token } from 'markdown-it'

interface LiftedSpan {
  token: Token
  attribute: NonNullable<Token['attrs']>[number]
  index: number
}

/** Keep attrs from re-applying spans whose covered cells MultiMarkdown already removed. */
export function preserveNativeTableSpans(markdown: MarkdownIt): void {
  const lifted = new WeakMap<StateCore, LiftedSpan[]>()
  markdown.core.ruler.before('curly_attributes', 'lift_native_table_spans', state => {
    let spans: LiftedSpan[] | undefined
    for (const token of state.tokens) {
      if (token.type !== 'td_open' && token.type !== 'th_open') continue
      const attrs = token.attrs
      if (!attrs) continue
      for (let index = attrs.length - 1; index >= 0; index -= 1) {
        const attribute = attrs[index]
        if (!attribute || (attribute[0] !== 'colspan' && attribute[0] !== 'rowspan')) continue
        spans ??= []
        spans.push({ token, attribute, index })
        attrs.splice(index, 1)
      }
    }
    if (spans) lifted.set(state, spans)
  })
  markdown.core.ruler.after('curly_attributes', 'restore_native_table_spans', state => {
    const spans = lifted.get(state)
    if (!spans) return
    // Reverse removal order preserves the original attribute pairs and positions,
    // while retaining the id/class/target attributes admitted by attrs itself.
    for (let index = spans.length - 1; index >= 0; index -= 1) {
      const span = spans[index]!
      span.token.attrs ??= []
      span.token.attrs.splice(span.index, 0, span.attribute)
    }
    lifted.delete(state)
  })
}
