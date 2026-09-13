const js = (value: unknown): string => JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hasControlCharacters = (value: string): boolean => [...value].some(character => character.charCodeAt(0) <= 32)
const externalUrl = (value: unknown, pageUrl: string, file = false): string => {
  const raw = String(value)
  if (hasControlCharacters(raw) || raw.includes('\\')) throw new Error('Discussion provider URL contains unsupported characters.')
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (file && (url.protocol !== 'https:' || url.pathname.endsWith('/')))) throw new Error(`Discussion provider requires an ${file ? 'HTTPS file' : 'HTTP or HTTPS base'} URL without credentials, query or fragment.`)
  try {
    if (new URL(pageUrl).protocol === 'https:' && url.protocol !== 'https:') throw new Error('Discussion providers on an HTTPS wiki must use HTTPS.')
  } catch (error) {
    if (error instanceof Error && error.message === 'Discussion providers on an HTTPS wiki must use HTTPS.') throw error
  }
  return file ? url.href : url.href.replace(/\/+$/, '')
}
const text = (value: unknown, label: string, pattern: RegExp, maximum = 255): string => {
  const result = String(value ?? '')
  if (!result || result.length > maximum || hasControlCharacters(result) || !pattern.test(result)) throw new Error(`Discussion provider requires a valid ${label}.`)
  return result
}
const option = <Value extends string>(value: unknown, values: readonly Value[], label: string): Value => {
  if (!values.includes(value as Value)) throw new Error(`Discussion provider requires a valid ${label}.`)
  return value as Value
}
const canonicalPageUrl = (pageId: number, pageUrl: string): string => new URL(`/i/${pageId}`, pageUrl).href
const pageIdentity = (pageId: number): string => `/i/${pageId}`

export const buildDiscussionEmbed = (key: string, config: Record<string, unknown>, pageId: number, pageUrl: string) => {
  const identity = pageIdentity(pageId)
  if (key === 'artalk') {
    const server = externalUrl(config.server, pageUrl)
    return { main: '<div id="artalk-container"></div>', head: `<link href="${attr(server)}/dist/Artalk.css" rel="stylesheet"><script src="${attr(server)}/dist/Artalk.js"></script>`, body: `<script>window.addEventListener('load',function(){Artalk.init({el:'#artalk-container',pageKey:${js(pageId)},pageTitle:document.title,server:${js(server)},site:${js(config.siteName ?? '')},darkMode:${config.darkMode === true ? "'auto'" : 'false'}});});</script>` }
  }
  if (key === 'comentario') {
    const server = externalUrl(config.instanceUrl, pageUrl)
    return { main: `<comentario-comments page-id="${identity}" no-fonts="true"></comentario-comments>`, head: `<script defer src="${attr(server)}/comentario.js"></script>`, body: '' }
  }
  if (key === 'commento') {
    const server = externalUrl(config.instanceUrl, pageUrl)
    return { main: '<div id="commento"></div>', head: '', body: `<script>window.addEventListener('load',function(){var s=document.createElement('script');s.src=${js(`${server}/js/commento.js`)};s.defer=true;s.setAttribute('data-auto-init','true');document.head.appendChild(s);});</script>` }
  }
  if (key === 'discourse') {
    const server = `${externalUrl(config.discourseUrl, pageUrl)}/`
    const userName = String(config.discourseUserName ?? '')
    if (userName.length > 100 || hasControlCharacters(userName)) throw new Error('Discussion provider requires a valid Discourse posting username.')
    return { main: '<div id="discourse-comments"></div>', head: '', body: `<script>window.DiscourseEmbed={discourseUrl:${js(server)},discourseEmbedUrl:${js(canonicalPageUrl(pageId, pageUrl))},discourseUserName:${js(userName)},discourseReferrerPolicy:'same-origin'};(function(){var s=document.createElement('script');s.src=window.DiscourseEmbed.discourseUrl+'javascripts/embed.js';s.async=true;s.referrerPolicy='same-origin';document.head.appendChild(s);})();</script>` }
  }
  if (key === 'disqus') {
    const accountName = text(config.accountName, 'Disqus shortname', /^[a-z0-9][a-z0-9-]{0,49}$/i, 50)
    return { main: '<div id="disqus_thread"></div>', head: '', body: `<script>var disqus_config=function(){this.page.url=${js(pageUrl)};this.page.identifier=${js(pageId)};};(function(){var s=document.createElement('script');s.src=${js(`https://${accountName}.disqus.com/embed.js`)};s.setAttribute('data-timestamp',+new Date());document.head.appendChild(s);})();</script>` }
  }
  if (key === 'giscus') {
    const repo = text(config.repo, 'Giscus repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    const repoId = text(config.repoId, 'Giscus repository ID', /^R_[A-Za-z0-9_-]+$/)
    const category = text(config.category, 'Giscus category', /^[^<>"]{1,100}$/, 100)
    const categoryId = text(config.categoryId, 'Giscus category ID', /^DIC_[A-Za-z0-9_-]+$/)
    const theme = option(config.theme, ['preferred_color_scheme', 'light', 'dark', 'transparent_dark'] as const, 'Giscus theme')
    const lang = text(config.lang, 'Giscus language', /^[a-z]{2}(?:-[A-Z]{2})?$/, 5)
    const attributes = { src: 'https://giscus.app/client.js', 'data-repo': repo, 'data-repo-id': repoId, 'data-category': category, 'data-category-id': categoryId, 'data-mapping': 'specific', 'data-term': identity, 'data-strict': '1', 'data-reactions-enabled': config.reactionsEnabled === false ? '0' : '1', 'data-emit-metadata': '0', 'data-input-position': 'top', 'data-theme': theme, 'data-lang': lang, 'data-loading': 'lazy', crossorigin: 'anonymous', async: '' }
    const script = Object.entries(attributes).map(([name, value]) => value === '' ? name : `${name}="${attr(value)}"`).join(' ')
    return { main: `<script ${script}></script>`, head: '', body: '' }
  }
  if (key === 'hyvortalk') {
    const websiteId = Number(config.websiteId)
    if (!Number.isSafeInteger(websiteId) || websiteId < 1) throw new Error('Discussion provider requires a positive Hyvor Talk website ID.')
    const colorScheme = option(config.colorScheme, ['os', 'light', 'dark'] as const, 'Hyvor Talk colour scheme')
    return { main: `<hyvor-talk-comments website-id="${websiteId}" page-id="${pageId}" page-url="${attr(canonicalPageUrl(pageId, pageUrl))}" colors="${colorScheme}"></hyvor-talk-comments>`, head: '<script async type="module" src="https://talk.hyvor.com/embed/embed.js"></script>', body: '' }
  }
  if (key === 'isso') {
    const server = externalUrl(config.server, pageUrl)
    return { main: `<section id="isso-thread" data-isso-id="${identity}"></section>`, head: `<link rel="stylesheet" href="${attr(server)}/css/isso.css">`, body: `<script data-isso="${attr(server)}/" src="${attr(server)}/js/embed.min.js"></script>` }
  }
  if (key === 'remark42') {
    const host = externalUrl(config.host, pageUrl)
    const siteId = text(config.siteId, 'Remark42 site ID', /^[A-Za-z0-9_.-]{1,100}$/, 100)
    const theme = option(config.theme, ['light', 'dark'] as const, 'Remark42 theme')
    const maxShownComments = Number(config.maxShownComments)
    if (!Number.isSafeInteger(maxShownComments) || maxShownComments < 1 || maxShownComments > 100) throw new Error('Discussion provider requires 1 to 100 initially shown Remark42 comments.')
    return { main: '<div id="remark42"></div>', head: '', body: `<script>window.remark_config={host:${js(host)},site_id:${js(siteId)},url:${js(canonicalPageUrl(pageId, pageUrl))},components:['embed'],theme:${js(theme)},max_shown_comments:${maxShownComments}};</script><script type="module" src="${attr(host)}/web/embed.mjs"></script>` }
  }
  if (key === 'waline') {
    const server = externalUrl(config.serverURL, pageUrl)
    const clientUrl = externalUrl(config.clientUrl, pageUrl, true)
    const styleUrl = externalUrl(config.styleUrl, pageUrl, true)
    const lang = text(config.lang, 'Waline language', /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, 8)
    return { main: '<div id="waline"></div>', head: `<link rel="stylesheet" href="${attr(styleUrl)}">`, body: `<script type="module">import(${js(clientUrl)}).then(function(m){m.init({el:'#waline',serverURL:${js(server)},path:${js(identity)},lang:${js(lang)},reaction:${config.reaction === true}});});</script>` }
  }
  throw new Error('Unsupported external discussion provider.')
}
