import { load } from 'cheerio'
import twemoji from 'twemoji'

const excludedAncestors = 'code, pre, script, style'

const plugin = {
  init(input: string, _config: Readonly<Record<string, unknown>>): string {
    void _config
    const $ = load(input)
    $('body, body *').contents()
      .filter((_index, node) => node.type === 'text' && $(node).parents(excludedAncestors).length === 0)
      .each((_index, node) => {
        if (node.type !== 'text') return
        const parsed = twemoji.parse(node.data, { folder: 'svg', ext: '.svg' })
        if (parsed !== node.data) $(node).replaceWith(parsed)
      })
    return $('body').html() ?? input
  }
}

export default plugin
