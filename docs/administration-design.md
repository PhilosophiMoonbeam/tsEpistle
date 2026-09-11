# Administration experience

Administration uses a shared control center for the wiki's content, access, intelligence, workspace configuration, and operations. Existing routes and server authorization remain in place.

## Structure

`client/helpers/admin-navigation.ts` is the settings catalog. It owns domain membership, destinations, translated labels, descriptions, search aliases, counts, and visibility permissions. Both the sidebar and dashboard directory consume the same filtered catalog. Add new settings there rather than maintaining a second navigation list. Visibility follows the existing permission alternatives; server handlers continue to enforce access independently.

Search matches all entered terms against the domain, title, description, and aliases. Navigation clears the search after selection, opens the destination's domain, and focuses the incoming heading. Agents remain discoverable for system administrators when disabled; the destination explains the deployment setting.

## Presentation

The shared `AdminHero` provides a semantic heading, contextual description, status, and actions. Its icon family matches the navigation. Typography and colors use the wiki's existing user preferences and theme tokens. Administration uses restrained borders and surfaces, compact navigation, and consistent form and table treatments. Decorative delayed entrance animations are disabled within administration.

The dashboard presents workspace inventory, search and agent/integration entry points, recent content and access activity, and a searchable directory. Summary failures show unavailable values with retry instead of false zero counts. Recent activity retains its independent loading, error, empty, permission, and request-generation handling.

General settings includes section anchors and a sticky save bar using the existing form validation and dirty state. Search index maintenance is separate from the Apply action. API keys can be filtered by name and revocation status, with a record layout on smaller screens; integration reference includes the MCP endpoint and its resource-bound authentication requirement.

## Unified tag library

Tags are one editorial vocabulary across public browsing at `/t`, Page Properties, and the system-administrator taxonomy workspace. The canonical `tag` is the lower-case identity used by URLs, assignments, and rules; an optional title is a display label, with the canonical name retained as secondary text when the label differs. The public library groups and searches that vocabulary locally, uses AND semantics for multi-selection, preserves locale/sort query parameters and encoded bookmarks, and keeps an unknown or historical alias token removable. It deliberately shows no usage counts and does not treat directory absence as proof that a name is invalid or globally unused.

The public index is a single responsive layout: its groups use three columns at `>=1280px`, two columns from `600px` through `1279.98px`, and one column below `599.98px`. With pages selected, desktop uses an index-and-results composition at `>=960px`; narrower layouts use an explicit Show tags/Hide tags disclosure and a View pages action that moves focus to the results heading. Search, selected-name removal, Clear selection, loading, retry, zero-match, local-filter-empty, and late-response states remain independently understandable. Result links reuse the existing public/private route helper and expose readable paths without manufacturing tag counts.

Page Properties keeps one native multi-value combobox. Suggestions are canonical strings, a typed value is presented as Add “[name]” to page, and the hint explains that a new name is created only when the parent page is saved. The properties dialog owns a draft: Cancel restores saved assignments, OK commits only to the page editor store, and no taxonomy request is made from authoring. Search failures retain typed input and chips and offer Retry; keyboard selection, chip removal, Escape, and newline-paste continue to use the installed control behavior.

Taxonomy administration remains behind `manage:system` and uses the existing taxonomy service and review contracts. Create, rename, merge, retire, and restore actions retain impact previews, fingerprints, acknowledgements for changed access, aliases, archived-name safeguards, page history/projection behavior, and post-commit refresh warnings. Dirty create drafts and definition/review drafts are protected from route, unload, and dismissal loss; a committed mutation remains distinct from a later inventory/detail reload failure, and a stale or failed preview cannot enable Apply.

These surfaces use existing semantic theme variables, typography, focus treatment, Vuetify controls, and reduced-motion behavior. Controls wrap at 320px, names and paths may break at safe boundaries, RTL tab movement remains keyboard-operable, and no page-level horizontal scrolling is introduced. No new tag store, endpoint family, migration, bulk operation, public count query, or editor-side taxonomy mutation is part of this design.

## Verification

- Unit/contract coverage: administration components, shared hero, navigation catalog, taxonomy lifecycle, and editor draft behavior.
- Responsive browser coverage: `dev/e2e/tags.e2e.ts` exercises public index filtering, multi-selection, removable unmatched bookmarks, retry/error states, latest-response-wins behavior, responsive disclosure, and result-heading focus. `dev/e2e/editor-panels.e2e.ts` exercises categorization suggestions, candidate addition, failure recovery, chip removal, Cancel versus OK, and the absence of taxonomy requests.
- Browser assertions use consumer-visible roles, names, focus, URLs, links, and state. This source description documents the interface contract and is not a deployment claim.

The tag experience preserves existing route, bookmark, authorization, taxonomy, page-save, history, and API contracts. It does not add a second taxonomy model or alter persisted configuration schemas.
