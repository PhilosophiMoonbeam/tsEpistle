---
name: wiki-authoring
description: Create and edit Wiki pages while preserving Markdown, links, and human-editor compatibility.
compatibility: tsEpistle Visual Markdown and Markdown source editors
metadata:
  owner: wiki-operations
allowed-tools:
  - wiki_search_pages
  - wiki_search_tags
  - wiki_list_tags
  - wiki_discover_pages
  - wiki_get_page
  - wiki_get_page_okf
  - wiki_read_page_for_patch
  - wiki_list_recent_pages
  - wiki_list_page_history
  - wiki_get_page_version
  - wiki_list_page_links
  - wiki_get_related_pages
  - wiki_prepare_page_create
  - wiki_prepare_page_patch
  - wiki_prepare_page_move
  - wiki_prepare_page_restore
  - wiki_apply_page_proposal
---
# Wiki authoring

Use this skill to discover, read, create, edit, move, or restore Wiki pages, or draft Wiki-compatible page source.

## Read before acting

1. Resolve the exact locale and path with search or page-read actions. Do not infer page identity from a title.
2. Read the authoritative page before making factual claims or editing it. Search and knowledge projections identify candidates; they are not page-source evidence or permission grants.
3. Use ordinary page reads by default. Call `wiki_get_page_okf` only for exact canonical OKF interchange or an exact source-revision document. OKF metadata is maintained by page operations; it does not replace authorization or source evidence.
4. Only Markdown pages support hashline patches. Do not convert or rewrite an HTML page; refer it to a human HTML-editor workflow.
5. Preserve terminology, heading hierarchy, link style, line endings, and final-newline state. Change only what the request requires.

## Compatible Markdown

For new pages, use GitHub Flavored Markdown supported by both Visual Markdown and the Markdown source editor: paragraphs, ATX headings, emphasis, fenced code blocks, lists, task lists, blockquotes, horizontal rules, basic images, rectangular tables, and ordinary links. For internal pages, follow nearby root-relative links and locale prefixes.

Do not introduce raw HTML, Markdown attributes, custom classes or IDs, merged or multiline tables, tabsets, math, diagrams, or footnotes unless the existing page uses that construct and the user asks to preserve or change it. Never replace Markdown source with rendered HTML. Skill source pages are an exception: retain their YAML frontmatter and edit them only in the Markdown source editor.

## Create

1. Search the requested path and likely collisions.
2. Provide a concise title and description, Markdown content, `contentType: "markdown"`, resolved locale and path, publication state, and intentional tags to `wiki_prepare_page_create`.
3. Wait for human approval. In built-in Agent chat, an approved proposal applies automatically. In MCP, use `wiki_apply_page_proposal` after approval.
4. Report the page as changed only after the action result confirms `status: "applied"`; read it again if final source or metadata must be verified.

## Edit

1. Read the page. Call `wiki_read_page_for_patch` with `previousSnapshotToken: null` and only the needed ranges; reuse a returned token only for the same page.
2. Build `wiki-line-patch-v1` from the exact document tag, snapshot token, line numbers, and line tags. Leave undisclosed lines untouched and preserve the final-newline state unless the request changes it.
3. Submit the patch with `wiki_prepare_page_patch`. If the revision or an anchor changed, reread and rebuild; never guess a token or tag.
4. Wait for human approval. In built-in Agent chat, approval applies automatically; in MCP, use `wiki_apply_page_proposal` after approval. Report success only after `status: "applied"` is confirmed.

## Discovery and interchange

Use `wiki_discover_pages` to browse concepts and `wiki_search_pages` for focused queries. Apply lifecycle filters only when the task needs them. Read the source with `wiki_get_page` before using a result as factual evidence. If knowledge is absent or partial, continue with the page source; do not invent missing fields. Use `wiki_get_page_okf` only for exact canonical interchange or a matching immutable source-revision resource.

Move and restore use the same prepare, approval, and apply rules. Deletion is deliberately excluded from this skill.
