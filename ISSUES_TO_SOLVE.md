Wiki: Remaining Issues and Refinement Targets

1. Offline Reliability

The progressive web app’s offline features remain unstable. Browser crashes occasionally occur when opening a page’s history. A similar crash previously occurred when signing out and then signing back in; that issue may be resolved.

Audit offline functionality, including interactions with authentication and page history. The experience should be stable, predictable, and seamless.

2. Offline Page Controls

The offline controls above the table of contents behave inconsistently:

* A page initially offers a cloud button to save it for offline use.
* After activation, the page does not appear to synchronize, or the interface reports that synchronization is unavailable.
* The cloud button becomes disabled and partially transparent.
* A red trash button labeled “Remove and exclude offline copy” appears but is also disabled.
* An additional message states, “This page is not eligible for an offline sync,” without explaining why.

This behavior affects the home page and other pages tested. Investigate both synchronization failures and incorrect eligibility or status reporting.

Replace the verbose button labels with concise tooltips. Prefer a single cloud toggle over separate cloud and trash buttons. Its appearance should indicate whether the page is saved offline.

Pages may be saved through several mechanisms:

* Automatic selection of frequently visited pages.
* Automatic selection of the most recently edited page.
* Manual selection by the user.

The toggle should work consistently regardless of how a page was added. Removing an automatically selected page should persist an exclusion preference so that it is not automatically added again. Where applicable, removal should free an automatic selection slot for another page.

Keep offline management separate from the page utility controls. Prefer placing it in the header or account menu; the exact location remains flexible.

3. Offline Status and PWA Installation

The status button immediately left of the account button appears to indicate connectivity through color. Clicking it adds a persistent green background, but its function is unclear.

If the button does not open a useful menu or management view, consider incorporating its status indicator into the account button. Distinguish connectivity from whether offline functionality is enabled.

Add offline information and controls to the account menu alongside notifications, approvals, appearance, and sign-out options. Include a PWA installation action when available so that users can discover installation without relying on browser-specific address-bar controls.

4. Search Overlay Appearance

Opening search currently makes the surrounding page background fully opaque. Dismissing search restores the underlying page.

Apply a translucent glass effect outside the search results panel so that the page remains visible beneath it. Use a lighter blur and less visual obstruction than the header, while retaining a clear glass effect.

5. WikiAgent Suggested Prompts

The two rotating lines of Buddhist text are well positioned and formatted. Preserve their current appearance.

Refine the three suggested prompt buttons beneath them:

* Move the group slightly lower, toward the center of the space between the introductory text and the bottom input field.
* Retain a slight upward bias toward the introductory text.
* Center each button’s title, Material Design icon, and description.
* Keep the right-edge arrow in its existing position.

Apply these changes to prompts such as “Understand this page,” “Connect the dots,” and “Catch up.”

6. WikiAgent Page Context and Transparency

Preserve the default inclusion of the current page as agent context. This should be the page visible immediately before WikiAgent opens. Users should remain able to toggle its inclusion.

When the page is included, visually connect WikiAgent to it through a translucent glass background:

* Show the underlying page through the main conversation area.
* Apply a stronger blur to the WikiAgent header so that underlying navigation and text are not readable.
* Keep user messages and agent responses opaque for readability.
* Keep the History and Memory panels opaque, retaining their existing backgrounds and colors.

The main background should provide an obvious visual connection to the included page without compromising conversation readability.

7. Search Navigation from WikiAgent

Clicking the magnifying-glass button in WikiAgent should immediately:

* Return to the page the user was viewing.
* Open the search interface and results panel.
* Focus the search field so that the user can begin typing.

8. Markdown Editor Selection Visibility

Text selection in the Markdown editor’s left pane works but is not visibly highlighted. Dragging across text selects it internally, and subsequent deletion or replacement affects that selection, but users cannot see what they have selected.

The blinking caret is visible. Fix the selection highlight so that users can reliably identify the text they are editing.

9. Page Utilities and Metadata

Keep page-specific utility controls—such as sharing, notification subscriptions, and printing—at the top of the table-of-contents column. Separate them from offline management.

Place the page metadata below the utility controls and above the table of contents. Center the last-updated information and author attribution rather than aligning them to the left. Review the small clock icon’s size and placement for clarity.

10. Page History

The page-history interface remains largely inherited from the upstream implementation, with some modifications.

Have the planning, design, and architecture agents review a more modern approach. Prioritize clarity and minimalism. Address the reported history-related crashes as part of the reliability audit.

11. Optional Agent and Edit Button Effects

Consider subtle hover transitions for the Agent and Edit buttons in the page header, affecting both their text and Material Design icons but not their button inside background color.

Possible treatments include:

* Blue or purple accents for Agent.
* A scholastic yellow accent for Edit.
* Subtle movement or other restrained animation.

Ensure that the effects work with user-configurable theme palettes. These refinements are optional and may be deferred if implementation proves disproportionately difficult, particularly given previous unsuccessful attempts.
