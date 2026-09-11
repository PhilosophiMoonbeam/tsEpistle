# Wiki UI Review Notes

## 1. Header layout

- Move the **WikiAgent** button from the right side of the search box to the left side.
- Move **Browse Tags** into the WikiAgent button’s current position, directly to the right of the search box.

## 2. Reader page

### Edit button

- The **Edit** button is clickable only on its upper half. Its lower half appears to overlap the boundary below the hero or page-description container and does not respond to clicks.
- At minimum, make the entire button clickable.
- If there is a clear design improvement, consider moving the button:
  - Into the upper-right area of the reader page, or
  - Closer to the page title and description, above its current position.

### Right-side column

- Raise the column that contains **Share**, **Notifications**, and **Page Contents**.
- Its top should align approximately with the vertical midpoint of the page-title text.

## 3. WikiAgent behavior

### Default opening behavior

- Opening WikiAgent should start a new chat by default.
- It currently opens the most recent chat, which requires an extra click to reach a new workspace.

### Pinning the current chat

- Add an option to pin the current chat.
- When pinned, WikiAgent should reopen that chat after the user navigates elsewhere in the wiki. This allows the chat to receive context from newly visited pages.
- Pinning must be deliberate and disabled by default.
- Do not place this control in the header. Consider placing it near **Skills** and **Goal** in the composer area.

### New and temporary chats

- Clicking **New** should immediately open a new saved chat.
- Do not ask the user to choose between a saved chat and a temporary chat before opening the new chat.
- Provide a separate option to convert or restart the chat as temporary.
- Consider placing the temporary-chat control in the header:
  - After **History** and **Memory**, or
  - Between **New** and the **Close** button.
- Select the final location based on visual clarity and available space.

### Default prompts

The default prompts include:

- **Understand this page**
- **Connect the dots**
- **Catch up**

Clicking one of these prompts currently inserts its text into the composer. Change this behavior so that clicking a prompt immediately submits it and starts the conversation.

### Redundant status text

- Remove the **New conversation ready** message from the upper-left corner.
- The ready indicator beside the **Send** button already communicates this state.

## 4. WikiAgent Mermaid output

- Mermaid diagrams are rendered adequately.
- The Mermaid source citation or syntax panel currently opens automatically.
- Keep this panel collapsed by default, consistent with other source sections.
- Users should expand it only when they want to inspect the Mermaid syntax.

## 5. WikiAgent reliability regression

The **Catch up** default prompt currently fails after completing its tool actions.

Observed behavior:

1. The agent performs approximately 11 actions successfully.
2. It lists recent pages and retrieves multiple pages.
3. The final response fails with the following message:

> Response failed. Response could not be completed. You can retry the same request or revise it in the composer.

Investigate this as a potential broader WikiAgent response-completion issue, not only a problem with the **Catch up** prompt.

## 6. Conversation history and folders

### Dragging conversations into a new folder

- Dragging conversations into existing folders works.
- When no folder exists, the user cannot use drag-and-drop organization.
- Allow the user to drag a conversation into the **Create a folder for conversations worth keeping** area.
- Dropping it there should open the new-folder dialog.
- After the user enters a folder name, create the folder and move the conversation into it.

### Folder-name field styling

- When the folder-name field receives focus, the **Folder name** label moves into the field border and changes color.
- The original gray border remains visible beneath the label, which reduces readability and creates a layered or translucent appearance.
- Investigate removing or masking the border behind the floating label.
- This is a minor issue and may be deprioritized if it cannot be reproduced reliably.

## 7. “Latest response” button

In long chats, the **Latest response** button appears when the user scrolls upward and correctly returns the user to the bottom.

Make the following visual adjustments:

- Reduce the button’s size by approximately 10% to 25%.
- Preserve the existing glowing gradient effect.
- Fix the visible seam where the glow is clipped by the composer-area boundary.
- The clipping appears above the **Add sources** button, near the gap between the chat and composer sections.

## 8. Login page branding

### Logo container

- Restore the framed logo container in the upper-left area of the login page.
- It should match the logo container shown in the signed-in wiki header.

### Successful-login animation

- The successful-login dialog still displays an animated logo inherited from the project that TS Epistle was forked from.
- Replace it with an original TS Epistle animation.
- An animated SVG is likely appropriate.
- Suggested concept:
  1. A closed book appears.
  2. The book opens.
  3. Several pages turn rapidly.
- The final animation should use TS Epistle branding and fit the current login-success dialog.
