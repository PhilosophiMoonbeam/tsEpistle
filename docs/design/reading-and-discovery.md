# Reading and discovery

The September 2026 review focused on the shared reading shell, site navigation, search entry, and the transition into Wiki Agent. The design direction is a quiet reference library: a distinct document title, restrained surfaces, readable body text, and navigation that supports the article.

## Implemented decisions

- The default **Editorial blend** pairs self-hosted Newsreader for document titles and the Wiki Agent welcome heading with Roboto Flex for reading and controls. A dedicated display token keeps these serif accents selective. **Newsreader** and **Roboto Flex** choices apply uniformly to proportional text, including titles; code remains monospace. The account menu previews and explains all three choices. New accounts and unset preferences default to blend; existing saved font choices are preserved. Document language and update time are visible beside the title.
- The desktop outline is narrower, leaving more room for content. Its own bounded list keeps filtering and page metadata reachable on long documents.
- Outlines with more than ten headings offer local filtering. Matches retain their ancestor chain; a clear empty state and clearing the field make recovery straightforward. No page content is sent to a service for this filter.
- The current reading section is marked with `aria-current="location"`. Geometry is cached on layout changes, and scrolling uses a binary search scheduled once per animation frame. Observers and listeners are disposed when the page is refreshed or unmounted.
- Tablet contents and page tools appear before the article in a compact row. Both tablet and phone contents start collapsed. The configured left/right/off outline placement remains supported.
- Section jumps take 250 ms and account for the fixed app bar. Reduced-motion preferences are respected. A skip link transfers keyboard focus to the article.
- Mixed navigation opens the page browser when no custom navigation exists. Static navigation remains administrator-controlled; saved browse preferences remain supported.
- Ctrl/Command+K opens and focuses search, including on phones. The desktop field shows the platform shortcut. Authorized users get a direct Wiki Agent button on larger screens, with the existing Search/Ask controls available at smaller widths.

## Verification

Targeted navigation, outline, search modal and inline Agent contracts; client type checking; repository lint; production build and bundle budgets. Browser checks cover live search, filtering, section jumps, active headings, Escape, skip-link focus, dark mode, reduced motion, and 320/390/768/1024/1440 px layouts. Real wiki content was used for browser verification; content and screenshots are deliberately excluded from this document.

## Further review areas

The editor, administration, and Agent memory management remain separate design reviews. In particular, assess how page provenance, Agent citations, revision review, and MCP access configuration can share vocabulary and reusable components. These changes do not alter search ranking, Agent inference, permissions, or the MCP protocol.
