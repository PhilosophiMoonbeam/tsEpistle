# Historical Visual Markdown with CKEditor implementation plan

Status: historical record — superseded by the current Tiptap implementation and contract; not ready for implementation

Supersession notice: this CKEditor proposal is retained only as historical design context. Do not implement it or use it as an active product contract. The current implementation uses Tiptap for both Visual Markdown and Visual HTML while preserving the persisted `visual-markdown` and `ckeditor` editor keys; `package.json`, `client/components/editor/tiptap/`, and `server/modules/editor/visual-markdown/definition.yml` define the current engine and canonical-content contract.

All goals, phases, candidate files, acceptance gates, and CKEditor statements below describe the superseded proposal rather than current or pending work.

## Goal

Add a new **Visual Markdown** editor that uses CKEditor 5 for WYSIWYG authoring and CKEditor’s stable Markdown data processor for canonical GitHub Flavored Markdown output. Retain the existing **Visual HTML** editor and the existing CodeMirror-based **Markdown** source editor.

The finished editor choices are:

| Editor key | User-facing name | UI | Canonical `pages.content` | `contentType` |
| --- | --- | --- | --- | --- |
| `markdown` | Markdown | CodeMirror source editor | Markdown | `markdown` |
| `visual-markdown` | Visual Markdown | CKEditor WYSIWYG | Markdown | `markdown` |
| `ckeditor` | Visual Editor | CKEditor WYSIWYG | HTML | `html` |
| `code` | Code | CodeMirror source editor | HTML | `html` |
| `asciidoc` | AsciiDoc | CodeMirror source editor | AsciiDoc | `asciidoc` |

Visual Markdown and Markdown must share the existing server Markdown rendering pipeline. Visual HTML must retain its current HTML storage and rendering behavior.

## Why this design

CKEditor 5 already ships a stable `Markdown` plugin. Installing that plugin in an editor configuration replaces the default HTML data processor with `MarkdownGfmDataProcessor`:

- `editor.setData(markdown)` accepts GFM Markdown.
- `editor.getData()` returns GFM Markdown.
- the existing HTML editor remains unchanged when the plugin is absent.

This is a bounded addition to the existing editor stack. It does not require a new document model, Tiptap, a migration of existing Visual HTML pages, or a new server renderer.

Relevant current CKEditor documentation:

- Markdown output: https://ckeditor.com/docs/ckeditor5/latest/features/markdown.html
- Markdown plugin API: https://ckeditor.com/docs/ckeditor5/latest/api/module_markdown-gfm_markdown-Markdown.html
- GFM data processor API: https://ckeditor.com/docs/ckeditor5/latest/api/module_markdown-gfm_gfmdataprocessor-MarkdownGfmDataProcessor.html

## Product contract

### Canonical data

Visual Markdown has one source of truth: GFM Markdown in `wikiStore.editor.content` and `pages.content`.

Published HTML continues to be derived by the server:

```text
CKEditor document
  -> editor.getData() as GFM Markdown
  -> wikiStore.editor.content
  -> page save with editor: visual-markdown
  -> pages.contentType: markdown
  -> existing Markdown rendering pipeline
  -> HTML in pages.render
```

Do not persist CKEditor HTML beside Markdown. Do not publish `editor.getData()` as HTML in Visual Markdown mode. Do not create a second client-side canonical representation.

### Existing editor preservation

The existing `ckeditor` key remains the Visual HTML editor:

- it continues to load and save HTML;
- it continues to use `js-beautify.html()` on output;
- existing HTML pages require no migration;
- existing routes and editor keys continue to reopen those pages in Visual HTML.

### Switching editors

Expected conversion behavior:

| From | To | Expected content operation |
| --- | --- | --- |
| Markdown | Visual Markdown | Change editor key only; both are Markdown |
| Visual Markdown | Markdown | Change editor key only; both are Markdown |
| Visual HTML | Visual Markdown | Existing HTML-to-Markdown conversion |
| Visual Markdown | Visual HTML | Existing rendered Markdown-to-HTML conversion |
| Code | Visual Markdown | Existing HTML-to-Markdown conversion |

The existing `server/models/pages.ts` conversion logic already compares source and target content types. Adding `visual-markdown` with `contentType: markdown` should make the same-content-type paths conversion-free. Add regression coverage rather than introducing a parallel conversion implementation.

## Markdown compatibility boundary

The project’s source Markdown editor supports more than standard GFM. Visual Markdown must initially promise only the subset that CKEditor can parse and serialize without loss.

### Required visual-safe GFM subset

The first release must round-trip these constructs semantically:

- paragraphs and hard paragraph boundaries;
- headings levels 1 through 6;
- bold, italic, and strikethrough;
- inline code;
- links, including internal absolute page links;
- ordered and unordered lists, including nesting;
- task lists;
- blockquotes;
- fenced code blocks with language identifiers;
- basic GFM tables;
- basic images with source and alternative text;
- horizontal rules.

“Round-trip semantically” means Markdown may be normalized, but parsing, serializing, and rendering it must preserve the same supported document structure. Byte-for-byte Markdown preservation is not required.

### Extended Markdown outside the initial contract

The current Markdown editor/server can represent constructs that are not standard GFM or are not losslessly represented by CKEditor’s Markdown processor:

- multiline, rowspan, or headerless tables;
- Markdown attributes, custom classes, IDs, and targets;
- styled callouts encoded through attributes;
- image dimensions, captions, resizing, and alignment classes;
- downloadable-link attributes;
- underline;
- superscript and subscript;
- marks/highlights;
- abbreviations;
- footnotes;
- KaTeX, MathJax, and chemistry syntax;
- Mermaid, PlantUML, Kroki, and draw.io representations;
- tabsets and pivot tables;
- arbitrary embedded HTML.

The implementation must not silently delete these constructs.

Before enabling Visual Markdown for an existing page, detect unsupported syntax using a conservative compatibility check. If unsupported syntax is present, block entry into Visual Markdown and show a clear notification directing the user to the Markdown source editor. False positives are preferable to content loss in the first release.

Do not add opaque nodes, custom Markdown tokenizers, or lossy fallbacks in this slice. Those are separate feature decisions after the visual-safe subset is proven.

### Markdown toolbar policy

Visual Markdown must expose only features proven to survive its Markdown processor. Start with:

- undo and redo;
- heading;
- bold, italic, and strikethrough;
- link;
- bulleted, numbered, and task lists;
- blockquote;
- inline code and fenced code block;
- horizontal rule;
- basic image insertion;
- basic table insertion and editing.

Do not expose these existing Visual HTML controls in Visual Markdown unless a round-trip test proves their representation:

- underline;
- image captions;
- image resize;
- image inline/block/side styles;
- custom list properties or styles;
- arbitrary indentation that is not list nesting;
- downloadable-link decorators;
- merged or nested tables.

The Visual HTML toolbar and behavior remain unchanged.

## Architecture

### Shared CKEditor component

Avoid copying `client/components/editor/editor-ckeditor.vue`. Extract format-specific choices while retaining a single CKEditor lifecycle and integration implementation.

Recommended contract:

```ts
type VisualEditorFormat = 'html' | 'markdown'
```

The shared CKEditor implementation accepts or derives:

- `format: 'html' | 'markdown'`;
- `editorKey: 'ckeditor' | 'visual-markdown'`;
- the format-specific plugin list;
- the format-specific toolbar list;
- the output normalization function.

Format behavior:

```text
html:
  plugins exclude CKEditor Markdown
  setData receives HTML
  getData returns HTML
  output passes through js-beautify.html

markdown:
  plugins include CKEditor Markdown
  setData receives Markdown
  getData returns Markdown
  output is stored directly without HTML beautification
```

Use either:

1. one shared implementation with two thin wrapper components; or
2. one component receiving explicit immutable format props from the editor registration.

Prefer the approach that keeps `client/components/editor.vue`’s dynamic editor selection straightforward and does not introduce runtime format switching inside a mounted CKEditor instance. The data processor is selected at editor creation and must not change during that instance’s lifetime.

### Candidate files

Expected production changes:

- `client/components/editor/editor-ckeditor.vue`
  - extract/share the current CKEditor lifecycle;
  - preserve HTML behavior exactly.
- `client/components/editor/editor-visual-markdown.vue`
  - thin Visual Markdown entry point if wrappers are used.
- `client/components/editor.vue`
  - async-register the new editor component.
- `client/components/editor/editor-modal-editorselect.vue`
  - add Visual Markdown as a creation choice.
- `client/components/common/page-convert.vue`
  - add Visual Markdown as a conversion target.
- `server/modules/editor/visual-markdown/definition.yml`
  - register key `visual-markdown` with `contentType: markdown`.
- locale resources under `server/locales/`
  - add user-facing editor and compatibility messages using the existing locale structure.

Possible supporting files, only if needed to keep logic testable:

- a focused CKEditor configuration module under `client/components/editor/ckeditor/`;
- a focused Markdown compatibility detector under `client/components/editor/markdown/` or shared editor helpers;
- fixture-driven tests adjacent to those helpers.

Do not change the server Markdown renderer, page schema, database schema, or storage adapters for this feature.

### Editor registration

Add the new server definition without changing the existing definitions:

```yaml
key: visual-markdown
title: Visual Markdown
description: Rich-text WYSIWYG editor with Markdown output
contentType: markdown
author: requarks.io
props: {}
```

`server/models/editors.ts#getDefaultEditor('markdown')` may continue returning `markdown`. This feature adds an editor choice; it does not change the global default editor policy unless separately requested.

### Store and save behavior

On Visual Markdown mount:

1. set `wikiStore.editor.editorKey = 'visual-markdown'`;
2. create CKEditor with the Markdown plugin;
3. call `editor.setData(wikiStore.editor.content)` for existing content;
4. initialize empty create-mode content without injecting HTML;
5. on `change:data`, debounce and assign `editor.getData()` directly to `wikiStore.editor.content`.

On conflict overwrite:

```ts
editor.setData(wikiStore.editor.content)
```

The editor shell continues to submit `wikiStore.editor.content` and `wikiStore.editor.editorKey` through its existing `getPageInput()` path.

### Shared project integrations

Preserve the existing event contracts:

- `onEditorInsert` / `offEditorInsert`;
- `onEditorLinkToPage` / `offEditorLinkToPage`;
- `onEditorSaveConflict` / `offEditorSaveConflict`;
- `onEditorContentOverwrite` / `offEditorContentOverwrite`.

Validate each insertion in Markdown output:

- image insertion serializes to a basic Markdown image;
- binary insertion serializes to a normal link unless a lossless downloadable representation is deliberately added later;
- page-link insertion serializes to the current locale-aware absolute path;
- unsupported diagram insertion is disabled or rejected with a clear notification rather than stored as a data URI or silently lost.

Do not advertise unsupported media behavior in the Visual Markdown toolbar.

## Implementation phases

### Phase 1: executable compatibility contract

Create a fixture set for the visual-safe GFM subset before exposing the editor in the selector.

Each fixture must exercise:

```text
input Markdown
  -> CKEditor Markdown setData
  -> CKEditor model
  -> CKEditor Markdown getData
  -> existing server Markdown rendering expectations
```

Required assertions:

- supported nodes and marks survive;
- fenced-code language survives;
- nested list structure survives;
- task checked state survives;
- table cells and headers survive;
- image source and alt text survive;
- internal links survive;
- no HTML beautifier touches Markdown output.

Add explicit rejection fixtures for representative unsupported syntax:

- Markdown attributes/callout classes;
- multiline or rowspan table syntax;
- footnotes;
- math;
- diagram fences or draw.io blocks unless proven safe;
- raw HTML;
- image-size syntax.

Acceptance gate: do not proceed to selector exposure until the supported fixture corpus passes and unsupported fixtures are blocked without modifying content.

### Phase 2: shared CKEditor format boundary

Refactor the existing CKEditor implementation to make output format explicit.

Requirements:

- Visual HTML behavior and toolbar remain unchanged;
- Visual HTML still beautifies HTML;
- Visual Markdown registers the Markdown plugin;
- Visual Markdown never calls the HTML beautifier;
- plugin and toolbar differences are declarative and reviewable;
- both modes tear down listeners and CKEditor instances on unmount;
- no duplicated editor lifecycle implementation.

Acceptance gate: an existing Visual HTML page loads, edits, saves, and emits the same HTML behavior as before.

### Phase 3: Visual Markdown registration and UX

Register `visual-markdown` end to end:

- server editor definition;
- async client component registration;
- creation selector card;
- page conversion selector option;
- status bar label;
- localized user-facing strings;
- Markdown-safe toolbar;
- unsupported-content guard.

The selector must clearly distinguish:

- **Visual Markdown** — Rich-text editing, Markdown output;
- **Visual Editor** — Rich-text editing, HTML output;
- **Markdown** — Source editing, Markdown output.

Acceptance gate: creating a page with Visual Markdown saves `editorKey: visual-markdown`, stores Markdown, and publishes through the Markdown renderer.

### Phase 4: conversion and integration verification

Exercise all supported editor transitions:

1. Markdown -> Visual Markdown -> Markdown without server conversion or semantic loss.
2. Visual HTML -> Visual Markdown through the existing HTML-to-Markdown conversion.
3. Visual Markdown -> Visual HTML through the existing Markdown-to-HTML conversion.
4. Visual HTML remains editable without any conversion.

Verify shared integrations:

- insert an internal page link;
- insert a basic image;
- save with keyboard and shell controls;
- trigger and resolve a simulated content overwrite/conflict;
- close with unsaved changes;
- reopen the saved page in the same editor.

Acceptance gate: page history records conversions where content type changes, while Markdown-to-Visual-Markdown editor changes retain Markdown content.

### Phase 5: cleanup and final verification

After behavioral smoke tests pass:

- remove any temporary compatibility probes or duplicated setup;
- confirm no CKEditor HTML feature was accidentally removed;
- confirm no dead imports or unused locale keys remain;
- update user-facing editor documentation if this repository has an existing relevant page; do not create unrelated documentation;
- run focused tests, full tests, typechecks, lint, and build once.

## Behavioral verification

### Automated checks

Run the focused tests while implementing, then run:

```bash
pnpm test
pnpm typecheck:client
pnpm typecheck:server
pnpm lint
pnpm build
```

Run `pnpm e2e` only if the existing suite is configured for the required authenticated editor flows. Otherwise use browser-driven smoke verification against the running application.

### Required browser smoke scenarios

#### Visual HTML regression

1. Open an existing Visual HTML page.
2. Confirm the full existing toolbar remains present.
3. Edit headings, a link, a table, and an image caption/style.
4. Save and reopen.
5. Confirm stored/published HTML behavior remains intact.

#### Visual Markdown creation

1. Create a page and choose Visual Markdown.
2. Author every supported toolbar construct.
3. Save and reopen in Visual Markdown.
4. Switch to the Markdown source editor.
5. Confirm the stored content is readable GFM Markdown.
6. View the published page and confirm server-rendered output.

#### Markdown interoperability

1. Create a visual-safe page in the Markdown source editor.
2. Change its editor to Visual Markdown.
3. Edit and save visually.
4. Change back to Markdown.
5. Confirm semantic structure is retained and only acceptable Markdown normalization occurred.

#### Unsupported syntax protection

1. Create a Markdown page containing representative extended syntax.
2. Attempt to change/open it in Visual Markdown.
3. Confirm entry is blocked before content changes.
4. Confirm the original Markdown remains byte-for-byte unchanged.

#### Conversion paths

1. Convert a representative Visual HTML page to Visual Markdown.
2. Inspect the generated Markdown and published output.
3. Convert a representative Visual Markdown page to Visual HTML.
4. Confirm page history and rendered output remain available.

### Storage evidence

For at least one Visual Markdown page, verify through the application/API or database inspection that:

- `editorKey` is `visual-markdown`;
- `contentType` is `markdown`;
- `content` is Markdown rather than HTML;
- `render` is generated HTML;
- reopening selects Visual Markdown.

## Tests that defend the contract

Add tests only where they defend observable behavior:

1. **Format configuration:** HTML mode excludes `Markdown`; Markdown mode includes it.
2. **Output handling:** HTML output is beautified; Markdown output is stored directly.
3. **Round-trip fixtures:** every visual-safe GFM construct survives CKEditor parse/serialize semantically.
4. **Compatibility guard:** representative unsupported syntax blocks Visual Markdown without mutation.
5. **Editor conversion:** same-content-type Markdown editor changes do not rewrite content; HTML/Markdown changes use conversion.
6. **Registration:** the new editor definition resolves to `contentType: markdown` and appears in creation/conversion choices.
7. **Existing Visual HTML regression:** its editor key, plugin behavior, and HTML output remain unchanged.

Avoid tests that only search source text or assert implementation details when the behavior can be exercised directly.

## Risks and controls

### Silent Markdown loss

Risk: CKEditor accepts content into its model but omits unsupported syntax on serialization.

Control: fixture contract plus conservative unsupported-syntax gate. Never rely on successful `setData()` alone as proof of preservation.

### Misleading toolbar

Risk: users apply HTML-only formatting that disappears from Markdown.

Control: separate Markdown-safe toolbar; no hidden fallback to HTML.

### Existing Visual HTML regression

Risk: adding the Markdown plugin to shared configuration changes HTML output globally.

Control: plugin selection is format-specific and immutable per editor instance. Visual HTML regression smoke is mandatory.

### Accidental HTML beautification of Markdown

Risk: the existing `beautify(editor.getData())` path rewrites Markdown incorrectly.

Control: explicit format output functions and a direct test proving Markdown bypasses `js-beautify`.

### Client/server dialect differences

Risk: CKEditor emits valid GFM that the existing markdown-it pipeline renders differently than expected.

Control: round-trip fixtures finish with the existing server rendering behavior, not CKEditor serialization alone.

### Raw HTML and custom attributes

Risk: unknown HTML or attributes disappear because they have no CKEditor model representation.

Control: block Visual Markdown for those pages in this slice. Do not use General HTML Support as an unverified catch-all.

### Conversion creates normalized content

Risk: HTML-to-Markdown conversion is inherently lossy.

Control: existing page-history snapshot behavior remains mandatory; browser smoke inspects representative conversions. Do not bulk-convert existing Visual HTML pages.

## Non-goals

- replacing CKEditor with Tiptap;
- removing or migrating the Visual HTML editor;
- changing the global default editor;
- storing Tiptap/ProseMirror/CKEditor JSON;
- storing Markdown and HTML as dual canonical sources;
- expanding the server Markdown dialect;
- implementing every extended Markdown feature visually;
- collaboration, comments, track changes, or premium CKEditor features;
- redesigning the overall editor shell or page metadata workflow;
- changing database schema or storage formats.

## Stop conditions

Stop and reassess instead of weakening the contract if:

- a required visual-safe GFM construct cannot round-trip through CKEditor 5;
- CKEditor’s Markdown plugin changes Visual HTML behavior when isolated as specified;
- unsupported syntax cannot be detected before CKEditor mutates it;
- Visual Markdown requires publishing client-generated HTML;
- basic images or links serialize into unstable/custom HTML rather than the agreed Markdown subset;
- implementation requires a database schema change;
- existing editor conversion rewrites Markdown when only the editor key changes;
- build, typecheck, or browser verification exposes unrelated editor regressions.

## Completion criteria

The feature is complete only when:

- Visual Markdown is independently selectable for page creation and conversion;
- Visual HTML remains available and behaviorally unchanged;
- Visual Markdown stores `contentType: markdown` and `editorKey: visual-markdown`;
- supported content round-trips between Markdown and Visual Markdown;
- unsupported extended Markdown is blocked without mutation;
- published output comes from the existing server Markdown pipeline;
- shared link, image, save, conflict, and unsaved-change workflows function;
- focused tests, full tests, client/server typechecks, lint, and build pass;
- required browser smoke scenarios pass;
- changes are committed and pushed on the current branch.

## Recommended commit structure

Use small, independently reviewable commits if the work naturally separates:

1. `test: define Visual Markdown compatibility contract`
2. `refactor: share CKEditor format configuration`
3. `feat: add CKEditor Visual Markdown editor`
4. `test: verify Visual Markdown conversions and workflows`

Do not leave a commit that exposes the selector before the compatibility guard and canonical Markdown persistence are working end to end.
