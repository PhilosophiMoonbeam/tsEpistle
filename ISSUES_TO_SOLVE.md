# Wiki Corrections and Improvements

## 1. Search Interface

### Search field and backdrop
- Clicking the header search field opens a prominent results panel. The panel is initially empty and populates as the user types.
- The current backdrop dims the search field along with the rest of the page. Keep the search field and the **Browse by Tags** button fully visible while search is active.
- Replace the current semi-opaque backdrop with the glass-style translucency used in the main Wiki header.

### Results panel
- Remove the unintended gap on the right side of the results panel.
- Correct the gradient background behind the filter controls, including **Language** and **This Page Tree**. It currently has a square edge and does not extend to the container boundary.
- Make the background fill the intended area and follow the panel’s rounded corners.

## 2. Wiki Agent Workspace

### Input area
- Reduce the height of the **Skills**, **Goal**, **Pin**, and **Send** buttons by approximately 10%, while preserving their current text and icon sizes.
- Use a 5% reduction if 10% would make the buttons too small for their contents.
- Reduce the input container height proportionally to recover vertical space.

### Welcome text
The current welcome text is:

> A little curiosity.  
> *A clearer picture.*

- Preserve the two-line format: standard text on the first line, colored italic text on the second.
- Move the text upward to provide at least one line of clear space above the suggested prompts: **Understand This Page**, **Connect the Dots**, and **Catch Up**.
- Create a pool of at least 10 short, positive, lightly humorous alternatives.
- Use two or three words per line.
- Give the text the voice of the Wiki’s AI agent: a helpful custodian or librarian with a playful sense of humor.
- Randomly select an entry each time the user visits the workspace.

### Source controls and Pin placement
The source controls currently occupy two rows above the input area:

- Scope selector: **All Wiki**, **This Page Tree**, or **Selected Pages**
- **Add Sources**
- Current page information, including language and path

Together, these rows occupy roughly one-third to one-half of the current input box height.

**Proposed layout:**
- Integrate the scope selector and **Add Sources** into the input area alongside the existing utility buttons.
- Use the same rounded button style as **Skills** and **Goal**.
- Integrate the current page information more compactly without removing it.
- Move **Pin** to the workspace header, next to **New**.
- Present **Pin** as a rounded toggle button with a pushpin icon and text. Match the typography and button shape of **New**, and size the icon appropriately for the header.

## 3. Page Reader and Mobile Navigation

### Left sidebar
- Keep the **Page Contents** section and the **Share**, **Notify**, and **Print** utilities largely unchanged.
- Give the online/offline status its own row rather than placing it among the utility icons.
- Increase the utility container height if needed.
- Alternatively, place the status in the metadata box below, alongside the updated date and participant information.

### Mobile Page Contents
- Make the expandable **Page Contents** control more visually distinct.
- Use color or shading that works in both light and dark modes.
- Make it clear that tapping the control opens the contents list for the current page.

## 4. PWA Controls and Account Menu

The PWA features have added another header button for app status and updates. Consolidate these controls to reduce header clutter.

- Move the PWA controls into the account/profile menu.
- Add a tooltip to the profile button. It currently provides no explanatory text on hover.
- Reorganize or slightly expand the profile menu as needed. Consider replacing low-value default items.

The menu should provide access to:
- Current app status
- **Check Server** or the existing update-check action
- **Apply Update**
- **Install**
- Offline features and saved-page management

Use a submenu for less frequently used controls if needed. Keep labels and icons clear so users can find installation, update, and offline functions.

## 5. Offline Pages and Synchronization

### Manual offline saving
- Add a per-page **Save Offline** control near the existing **Share**, **Notify**, and **Print** utilities.
- Activating it should immediately begin downloading a local copy for use without an Internet connection.
- Keep manually selected pages synchronized while a connection is available.
- Provide a menu for viewing and managing saved pages.

### Automatic offline saving
- When offline functionality is enabled, automatically save the user’s 10 most-visited pages.
- Update the selection as usage changes.
- Do not necessarily remove a saved page as soon as it falls out of the top 10.
- Consider an inactivity-based expiration policy for automatically saved pages, such as removal after two months without use.
- Keep explicitly selected pages saved until the user removes them.

### Tag-based synchronization
- Let users select one or more tags for continuous offline synchronization.
- Make this option available through tag browsing or a similar interface.
- Automatically download pages associated with the selected tags.
- Include newly created pages with those tags and existing pages that later receive those tags.

## 6. Agent Validation

After implementing, committing, and pushing the corrections:

- Run a general functional test of the Wiki Agent.
- Verify that it can invoke all available tools without failures.
- Investigate reported tool failures rather than treating them as expected behavior.
- Test the **Goal** feature with a short, simple goal.
- Check the overall interaction flow, including source selection, tool use, and goal execution.

## 7. Goal Token Budgets

Consider using the configured utility LLM to assign a maximum token budget to each goal.

- Define two or three preset budget tiers, once exhausted a user must click to confirm thus assigned a new budget.
- Have the utility model quickly classify the goal and select an appropriate tier.
- Apply the selected tier as the goal’s maximum token budget.