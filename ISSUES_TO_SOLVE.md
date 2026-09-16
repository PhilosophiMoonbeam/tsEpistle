# Wiki: Required Fixes and Design Refinements

## 1. Progressive Web App (PWA): Offline Access

### Status indicators and placement

Connection status and offline-copy information currently appear in the utility-icons column. The cloud icon appears to indicate that offline access is unavailable, possibly incorrectly.

The text below the icons also needs improvement:

- **Connection: Server verified** has no color to indicate connection health.
- **Offline copy: This page is not available for offline use. No local copy was kept.** is too verbose.
- The interface does not explain how to save a page for offline use.

Use clear visual indicators for connection health:

- **Green:** Connected and working.
- **Yellow:** Pending, warning, or degraded connection.
- **Red:** Connection failure.

Consider moving general connection and server information to the header. It should not compete with page utilities, edit-history metadata, or the table of contents.

Use planner, architect, and designer subagents to determine how these controls and indicators should fit into the existing interface. Connection health and page-sync selection must remain distinguishable, whether presented together or separately.

### Offline page selection

Support and verify three methods of selecting pages for offline access:

| Method | Expected behavior |
|---|---|
| Automatic selection | Include the user’s 10 most visited pages. Consider including recently edited pages as an additional automatic rule. |
| Individual page selection | Let users pin a page for ongoing synchronization through a utility icon. |
| Tag-based selection | Let users follow a tag and automatically synchronize all pages with that tag. |

Some of this functionality may already exist. Review the implementation and verify that all three methods work as expected.

### Page-sync control

Provide a cloud icon or equivalent control that lets users pin an individual page for ongoing synchronization.

- Use the normal utility-icon style when the page is not selected for synchronization.
- Apply a persistent, theme-compatible highlight when the page is included in the offline set.
- A circular selected-state background is optional. Highlighting the icon itself may be sufficient.
- Apply the same inclusion indicator when a page is selected automatically or through a followed tag. Users should be able to identify synchronized pages without having selected each page manually.

### Tag-sync controls

Consider placing tag-sync controls on the **Browse by Tags** page, accessible through the button beside the search box.

The existing searchable tag list should let users mark tags for synchronization. All pages associated with a selected tag should enter the user’s offline set, including pages with overlapping tags.

## 2. Wiki Agent: Failed Page Retrievals

The default **Catch up** prompt reproduces a retrieval problem:

> Summarize the most recently updated Wiki pages I can access.

The agent returns an answer with sources, but its activity log shows **11 actions, including seven failures**.

The reported sequence is:

- One successful `pages.list` action for recent pages.
- Three successful `pages.get` actions.
- Seven failed `pages.get` actions.

The agent appears to retrieve a list of recent pages but can fetch only three of them. Investigate why those three requests succeed while the other seven fail.

## 3. Wiki Agent: Welcome Text and Default Prompts

### Layout

The initial agent page displays a rotating or randomly selected two-line message:

- The first line uses regular text.
- The second line uses italic, colored text as the punchline.

Keep this treatment, but adjust the spacing:

- Move the message slightly farther below the header.
- Increase the gap between the message and the three default prompts.
- Use at least one full line of the message’s text height as the gap, preferably slightly more.

### Writing guidelines

Expand the message set with sharper, more playful humor.

- Use light jokes about sales, office culture, and related subjects.
- Keep the tone tongue-in-cheek without becoming too edgy.
- Favor original or unexpected second-line punchlines.
- Target two to three words per line.
- Allow one long word to occupy a line.
- Allow up to four words when short words such as “a” or “the” make that appropriate.
- Keep both lines approximately equal in displayed width, ideally within a few percentage points.

## 4. Light and Dark Mode: Transition Performance

Switching between light and dark mode appears slow and visually uneven.

Observed behavior:

- The transition feels as though it takes one to two seconds.
- Most of the interface changes first.
- Other elements change shortly afterward.

The final theme is applied, but the staggered transition creates a visible distraction.

Investigate rendering, theme application, and any relevant caching behavior. Apply the theme consistently across elements without unnecessary delay.

Use planner, architect, and designer subagents to review the implementation. Preserve visual fidelity while removing avoidable performance costs.

## 5. Search: Backdrop, Dismissal, and Filters

### Backdrop styling

Opening search results applies a color tint to the page below the header. Replace or refine this treatment with a subtle translucent-glass effect, if feasible.

- Keep the existing header and search-box styling unchanged.
- Use less blur or diffusion than the header.
- Keep the underlying page more visible than it is through the header.
- Make the effect consistent with the existing visual design.

### Dismissal controls

Consider removing the close button beneath the header at the upper right.

Search results already close when the user:

- Clicks the page outside the search area.
- Presses **Escape**.

The additional close button appears redundant and may imply that users must click it to dismiss search.

### Search filters

Verify that both search scopes work correctly:

- **All Wiki**
- **Downloaded Pages**

Confirm actual filtering behavior, not just the presence of the controls.

## 6. Table of Contents: Bottom-of-Page Behavior

The table of contents generally tracks the reader’s position correctly. At the bottom of a page, however, scrolling and selection become inconsistent.

Observed issues:

- Reaching the bottom correctly selects the final applicable heading.
- The table-of-contents panel does not scroll far enough to show the full selected item.
- The selected item’s text and highlight appear slightly clipped.
- Selection can jump from an earlier heading directly to the final heading, skipping intermediate headings near the bottom.
- Clicking those intermediate headings can move the reader to the same bottom position.
- Further scrolling changes the selection again.

Improve coordination between reader position, heading selection, and table-of-contents scrolling. Keep the active item fully visible and handle headings near the bottom more smoothly.

Use planner, architect, and designer subagents to review the interaction.

## 7. Reading Progress Indicator

Keep the reading-progress line beneath the header. It is particularly useful on mobile, where the scrollbar may not remain visible.

Its current visual intensity appears uniform. Adjust it so that intensity increases with reading progress:

- Start slightly softer than the current appearance.
- Increase intensity gradually.
- End slightly stronger than the current appearance.

Apply this behavior in both light and dark mode using the appropriate theme colors.

## 8. View Source: Formatting and Layout

### Markdown display

**Page Actions → View Source** currently displays the entire Markdown source as one long, horizontally scrollable line.

Preserve the source’s original line breaks and structure. Users should see correctly formatted, unrendered Markdown.

### Source controls

Keep the existing **Download** button and add a **Copy** button that copies the complete raw Markdown to the clipboard.

### Page layout

Review the entire View Source page with planner, architect, and designer subagents.

Observed concerns:

- The footer or footer-like blank area occupies roughly one-third of the page.
- The source-code link uses normal footer-sized text but sits within this unusually large area.
- The excess space may indicate a rendering or layout problem.
- If the page scrolls, the header should retain the same glass treatment used on standard Wiki pages.

## 9. Editor: Closing, Layout, and Theme Consistency

### Closing without changes

The editor can become impossible to close normally, even when the user has made no changes.

Observed sequence:

1. Open a page in the editor.
2. Make no changes.
3. Select **Close**.
4. The **Discard unsaved changes** dialog appears.
5. Select **Discard changes**.
6. Nothing happens.
7. Select **Save and Close**.
8. The page renders and saves as though it had changed.

In the observed case, normal closing did not work until **Save and Close** had been used at least once.

Investigate incorrect change detection and the failed discard action. Determine whether older pages require a migration or resave.

If maintenance is required:

- Explain the requirement when user action is necessary.
- Consider handling maintenance automatically when no user edits exist, rather than presenting an inaccurate unsaved-changes dialog.

The need for maintenance or resaving is a hypothesis, not a confirmed cause.

### Clipped interface elements

Correct horizontal layout problems in the editor:

- The administration button in the main header is partially clipped on the right.
- Other controls farther to the right may also be affected.
- The line and column information in the editor footer is either clipped or too close to the right edge.

### Theme consistency

The editor appears visually out of step with the rest of the application.

Observed issues:

- In light mode, both the Markdown pane and rendered preview use white backgrounds.
- The actual reader page uses the user-configured theme background.
- The rendered preview therefore does not accurately represent the page appearance.
- Editor toolbar areas use a parchment-like color that does not appear to match the configured theme.

Required review:

- Make the rendered preview respect the reader’s background and theme settings in both light and dark mode.
- Consider applying the same background to the Markdown pane for consistency.
- Verify toolbar colors against the application’s theme system.
- Remove unexplained visual differences between the editor and reader.

## 10. Navigation: Home Button

Refine the Home button’s active state and dimensions.

### Active state

The selected state mainly illuminates the background, while the house icon remains a dark silhouette.

- Keep a subtle background highlight.
- Give the house icon a stronger active-state highlight.

### Dimensions

Set the Home button’s height to match the outer container that holds **Main Menu** and **Browse**.

This will make the Home button slightly taller than the individual buttons inside that container while aligning it with the overall navigation group.

## 11. Browse Dialog: Visual Refinement

The Browse dialog works but looks plain, especially when no item is selected.

Ask planner, architect, and designer subagents to review the folder hierarchy and list presentation.

- Preserve the current-page highlight, which is visually effective.
- Add subtle visual structure where useful.
- Keep changes restrained and consistent with the rest of the application.
- Avoid unnecessary decoration.

## 12. Review and Verification

Use planner, architect, and designer subagents throughout these changes, not only for isolated redesigns.

For each affected area:

- Confirm the reported behavior.
- Distinguish existing functionality from missing or incomplete functionality.
- Review architectural, interaction, and visual implications.
- Verify the implemented behavior directly.
- Preserve visual fidelity while improving consistency and performance.