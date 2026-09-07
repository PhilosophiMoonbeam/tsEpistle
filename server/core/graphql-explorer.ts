import { GRAPHQL_IDE_VERSION } from '../../shared/graphql-ide.ts'
import { renderGraphiQL, type GraphiQLOptions } from 'graphql-yoga'

export const GRAPHQL_STARTERS = Object.freeze({
  pages: {
    title: 'Page inventory',
    query: 'query PageInventory {\n  pages {\n    list(limit: 10) {\n      id\n      title\n      path\n      locale\n    }\n  }\n}'
  },
  search: {
    title: 'Search pages',
    query: 'query SearchPages($query: String!) {\n  pages {\n    search(query: $query) {\n      results { id title path locale }\n    }\n  }\n}',
    variables: '{"query":"wiki"}'
  },
  schema: {
    title: 'Schema entry points',
    query:
      'query SchemaEntryPoints {\n  __schema {\n    queryType { name fields { name description } }\n    mutationType { name fields { name description } }\n  }\n}'
  }
})

export const GRAPHQL_EXPLORER_OPTIONS: GraphiQLOptions = Object.freeze({
  title: 'GraphQL workspace · tsEpistle',
  subscriptionsProtocol: 'WS',
  credentials: 'same-origin',
  shouldPersistHeaders: false,
  defaultQuery:
    '# Your signed-in session is used unless you supply a bearer token.\n# Permissions and page rules apply. Mutations change real data.\n\n' +
    GRAPHQL_STARTERS.pages.query,
  defaultTabs: [{ query: GRAPHQL_STARTERS.pages.query }],
  defaultEditorToolsVisibility: 'variables',
  schemaDescription: true
})

/** Static workspace chrome around Yoga's full schema-aware IDE. No user data enters this HTML. */
export const renderWorkspaceGraphiQL = (options: GraphiQLOptions): string => {
  const starters = JSON.stringify(GRAPHQL_STARTERS).replaceAll('<', '\\u003c')
  const styles = `<meta name="viewport" content="width=device-width, initial-scale=1"><style>
    html,body { margin:0; height:100%; overflow:hidden; }
    body { display:flex; flex-direction:column; }
    .graphiql-logo { display:none; }
    body .graphiql-container { --color-primary:38,58%,34%; --font-family:system-ui,sans-serif; }
    .graphiql-doc-explorer-root-type { color:inherit !important; }
    .graphiql-doc-explorer a { color:inherit !important; text-decoration:underline; text-underline-offset:3px; }
    .monaco-editor.vs-dark .line-numbers { color:#b4bfcc !important; }
    .monaco-editor.vs-dark .mtk8 { color:#a2bd90 !important; }
    #root { flex:1; min-height:0; height:auto; }
    .workspace-guide select,.workspace-guide textarea,.workspace-guide button { color:inherit; background:transparent; border:1px solid #8a8c7e; border-radius:6px; }
    .workspace-guide option { color:#282920; background:#f7f7f3; }
    .workspace-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 1.5rem; background:#f7f7f3; color:#282920; border-bottom:1px solid #d8d8cf; font:14px/1.5 system-ui,sans-serif; }
    .workspace-brand { display:flex; align-items:center; gap:1rem; }.workspace-brand strong { font:500 24px Georgia,serif; }.workspace-brand span { font-size:12px; }
    .workspace-actions { display:flex; gap:.6rem; align-items:center; }.workspace-actions a,.workspace-actions button { padding:.5rem .8rem; border:1px solid #8a8c7e; border-radius:7px; color:inherit; text-decoration:none; font:inherit; background:transparent; cursor:pointer; }
    .workspace-actions a:focus-visible,.workspace-actions button:focus-visible { outline:2px solid #89622a; outline-offset:3px; }
    .workspace-guide { background:#f7f7f3; color:#282920; border-bottom:1px solid #d8d8cf; padding:1.25rem 1.5rem; font:14px/1.7 system-ui,sans-serif; max-height:45vh; overflow:auto; }.workspace-guide[hidden] { display:none; }.workspace-guide-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.3fr); gap:2rem; }.workspace-guide h2 { font:500 23px Georgia,serif; margin:0 0 .5rem; }.workspace-guide p { margin:.5rem 0 1rem; }.workspace-guide label { display:block; margin-bottom:.5rem; }.workspace-guide select { font:inherit; padding:.4rem; max-width:100%; }.workspace-guide textarea { box-sizing:border-box; width:100%; min-height:130px; padding:.8rem; margin-top:.75rem; font:12px/1.6 monospace; resize:vertical; border:1px solid #8a8c7e; border-radius:6px; }.workspace-guide button { font:inherit; padding:.4rem .75rem; margin-top:.5rem; cursor:pointer; }.workspace-guide code { overflow-wrap:anywhere; }
    @media(prefers-color-scheme:dark) { .workspace-bar,.workspace-guide { background:#202321; color:#eeeee4; border-color:#43473e; }.workspace-actions a,.workspace-actions button { border-color:#8a8c7e; } }
    body.graphiql-dark .graphiql-container { --color-primary:38,65%,68%; }
    @media(prefers-color-scheme:dark) { body:not(.graphiql-light) .graphiql-container { --color-primary:38,65%,68%; } }
    @media(max-width:700px) { .workspace-bar { padding:.75rem; flex-wrap:wrap; gap:.5rem; }.workspace-brand strong { font-size:20px; }.workspace-brand span { display:none; }.workspace-guide { padding:1rem; }.workspace-guide-grid { grid-template-columns:1fr; gap:1rem; }.workspace-actions { flex-wrap:wrap; }.workspace-actions a,.workspace-actions button { font-size:12px; padding:.4rem .6rem; } }
    @media(max-width:700px) {
      .graphiql-main:has(> .graphiql-plugin:not(:empty)) > .graphiql-sessions,
      .graphiql-main:has(> .graphiql-plugin:not(:empty)) > .graphiql-horizontal-drag-bar { display:none; }
      .graphiql-main > .graphiql-plugin { flex:1 1 0% !important; min-width:0 !important; }
    }
  </style>`
  const chrome = `<header class="workspace-bar"><div class="workspace-brand"><strong>GraphQL workspace</strong><span>tsEpistle / API exploration</span></div><nav class="workspace-actions" aria-label="Workspace controls"><button id="workspace-help" type="button" aria-expanded="false" aria-controls="workspace-guide">Starter queries &amp; help</button><a href="/a/api#explore">API administration</a><a href="/">Back to wiki</a></nav></header>
  <section id="workspace-guide" class="workspace-guide" hidden aria-label="GraphQL workspace guide"><div class="workspace-guide-grid"><div><h2>Explore with your current access.</h2><p>Your browser session authenticates requests by default. Supply an <code>Authorization: Bearer &lt;API_KEY&gt;</code> header to evaluate a credential instead. Header persistence is disabled for this workspace.</p><p>Queries and variables may remain in this browser’s local IDE history. Mutations affect real wiki data. Use schema documentation to check required arguments, and inspect the response’s <code>errors</code> field even when HTTP status is 200.</p></div><div><label for="workspace-starter">Read-only starter query</label><select id="workspace-starter"><option value="pages">Page inventory</option><option value="search">Search pages</option><option value="schema">Schema entry points</option></select><textarea id="workspace-query" readonly aria-label="Starter query"></textarea><p id="workspace-variables"></p><button id="workspace-copy" type="button">Copy query</button><span id="workspace-copy-status" role="status" aria-live="polite"></span></div></div></section>`
  const script = `<script>(function(){const starters=${starters};const help=document.getElementById('workspace-help'),guide=document.getElementById('workspace-guide'),picker=document.getElementById('workspace-starter'),query=document.getElementById('workspace-query'),variables=document.getElementById('workspace-variables'),status=document.getElementById('workspace-copy-status');help.addEventListener('click',()=>{guide.hidden=!guide.hidden;help.setAttribute('aria-expanded',String(!guide.hidden));window.dispatchEvent(new Event('resize'));});function select(){const entry=starters[picker.value];query.value=entry.query;variables.textContent=entry.variables?'Variables: '+entry.variables:'';status.textContent='';}picker.addEventListener('change',select);document.getElementById('workspace-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(query.value);status.textContent=' Copied.';}catch{query.focus();query.select();status.textContent=' Select and copy the query.';}});select();
    // Treat the document selector as a group of toggle/close controls. The bundled
    // tablist nests independent close buttons inside tabs, which hides controls from AT.
    const ide=document.getElementById('root');
    function repairTabs(){for(const list of ide.querySelectorAll('.graphiql-tabs'))list.setAttribute('role','group');for(const panel of ide.querySelectorAll('[role="tabpanel"]'))panel.setAttribute('role','region');for(const item of ide.querySelectorAll('.graphiql-tab')){const tab=item.querySelector('.graphiql-tab-button');if(!tab)continue;const selected=item.classList.contains('graphiql-tab-active');item.setAttribute('role','presentation');item.removeAttribute('aria-selected');tab.setAttribute('role','button');tab.setAttribute('aria-pressed',String(selected));tab.tabIndex=0;const close=item.querySelector('.graphiql-tab-close');if(close)close.setAttribute('aria-label','Close '+tab.textContent);}}
    new MutationObserver(repairTabs).observe(ide,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});repairTabs();
    ide.addEventListener('keydown',event=>{const current=event.target.closest?.('.graphiql-tab-button');if(!current||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=Array.from(ide.querySelectorAll('.graphiql-tab-button'));const index=tabs.indexOf(current);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;event.preventDefault();event.stopPropagation();if(tabs[next]!==current)tabs[next].click();tabs[next].focus();},true);
  })();</script>`
  // The bundled Yoga IDE accepts `query` as its initial document, ahead of its generated welcome text.
  const ideOptions: GraphiQLOptions & { query?: string } = { ...options, ...(options.defaultQuery ? { query: options.defaultQuery } : {}) }
  return renderGraphiQL(ideOptions)
    .replaceAll(`https://unpkg.com/@graphql-yoga/graphiql@${GRAPHQL_IDE_VERSION}/dist/`, `/_assets/graphiql/${GRAPHQL_IDE_VERSION}/`)
    .replace('https://raw.githubusercontent.com/graphql-hive/graphql-yoga/refs/heads/main/website/src/app/favicon.ico', '/_assets/favicon.ico')
    .replace('</head>', styles + '</head>')
    .replace('<noscript>', chrome + '<noscript>')
    .replace('</body>', script + '</body>')
    .replaceAll('Loading __TITLE__...', 'Loading GraphQL workspace…')
}
