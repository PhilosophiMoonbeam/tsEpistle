import { describe, expect, it } from '../bun-test.mts'
import { buildDiscussionEmbed } from '../../helpers/discussion-embed.ts'
describe('external discussion embed boundaries', () => {
  it('escapes executable context characters in site names and page URLs', () => {
    const dangerous = "'</script><script>alert(1)</script>\u2028"
    const artalk = buildDiscussionEmbed('artalk', { server: 'https://comments.example.invalid', siteName: dangerous }, 7, 'https://wiki.local/i/7')
    expect(artalk.body).not.toContain("'</script>"); expect(artalk.body).toContain('\\u003c/script>'); expect(artalk.body).toContain('\\u2028'); expect(artalk.body.match(/<script>/g)).toHaveLength(1)
    expect(buildDiscussionEmbed('disqus', { accountName: 'community' }, 7, dangerous).body.match(/<script>/g)).toHaveLength(1)
  })
  it('rejects credentials, executable schemes and invalid shortnames', () => {
    for (const server of ['javascript:alert(1)', 'https://user:pass@service.invalid', 'https://service.invalid/?secret=1', 'https://service.invalid/#fragment']) expect(() => buildDiscussionEmbed('artalk', { server }, 1, '')).toThrow()
    expect(() => buildDiscussionEmbed('disqus', { accountName: "a';alert(1)" }, 1, '')).toThrow()
  })
  it('normalizes a trailing slash without dropping a self-hosted base path', () => {
    const embed = buildDiscussionEmbed('commento', { instanceUrl: 'https://example.invalid/discussions/' }, 1, '')
    expect(embed.body).toContain('https://example.invalid/discussions/js/commento.js')
  })
  it('builds every adapted provider with stable page identity and typed flags', () => {
    const pageUrl = 'https://wiki.local/renamed/path?unlock=secret#fragment'
    const embeds = {
      comentario: buildDiscussionEmbed('comentario', { instanceUrl: 'https://comments.example.invalid/base' }, 7, pageUrl),
      discourse: buildDiscussionEmbed('discourse', { discourseUrl: 'https://forum.example.invalid/base', discourseUserName: '' }, 7, pageUrl),
      giscus: buildDiscussionEmbed('giscus', { repo: 'owner/repo', repoId: 'R_repo', category: 'Announcements', categoryId: 'DIC_category', theme: 'light', reactionsEnabled: false, lang: 'en' }, 7, pageUrl),
      hyvortalk: buildDiscussionEmbed('hyvortalk', { websiteId: 42, colorScheme: 'os' }, 7, pageUrl),
      isso: buildDiscussionEmbed('isso', { server: 'https://isso.example.invalid/base' }, 7, pageUrl),
      remark42: buildDiscussionEmbed('remark42', { host: 'https://remark.example.invalid/base', siteId: 'wiki', theme: 'dark', maxShownComments: 20 }, 7, pageUrl),
      waline: buildDiscussionEmbed('waline', { serverURL: 'https://waline.example.invalid/base', clientUrl: 'https://cdn.example.invalid/waline.js', styleUrl: 'https://cdn.example.invalid/waline.css', lang: 'en', reaction: false }, 7, pageUrl)
    }
    for (const embed of Object.values(embeds)) expect(`${embed.head}${embed.main}${embed.body}`).toContain('/i/7')
    expect(embeds.giscus.main).toContain('data-mapping="specific"')
    expect(embeds.giscus.main).toContain('data-strict="1"')
    expect(embeds.giscus.main).toContain('data-reactions-enabled="0"')
    expect(embeds.discourse.body).not.toContain('unlock=secret')
    expect(embeds.isso.body).not.toContain('require-author')
    expect(embeds.remark42.body).toContain('/web/embed.mjs')
  })
  it('rejects mixed content, malformed base URLs and non-file Waline assets', () => {
    expect(() => buildDiscussionEmbed('isso', { server: 'http://isso.example.invalid' }, 1, 'https://wiki.local/i/1')).toThrow()
    expect(() => buildDiscussionEmbed('comentario', { instanceUrl: 'https://comments.example.invalid/a b' }, 1, 'https://wiki.local/i/1')).toThrow()
    expect(() => buildDiscussionEmbed('waline', { serverURL: 'https://waline.example.invalid', clientUrl: 'https://cdn.example.invalid/', styleUrl: 'https://cdn.example.invalid/waline.css', lang: 'en', reaction: false }, 1, 'https://wiki.local/i/1')).toThrow()
  })
})
