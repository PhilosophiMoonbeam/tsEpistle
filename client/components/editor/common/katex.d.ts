import MarkdownIt from 'markdown-it'

type MarkdownItInstance = InstanceType<typeof MarkdownIt>
type InlineRule = Parameters<MarkdownItInstance['inline']['ruler']['after']>[2]
type BlockRule = Parameters<MarkdownItInstance['block']['ruler']['after']>[2]

declare const katexHelper: {
  katexInline: InlineRule
  katexBlock: BlockRule
}

export default katexHelper
