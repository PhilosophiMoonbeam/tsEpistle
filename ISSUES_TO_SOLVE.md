# Wiki Corrections

## Page Layout and Header

### Footer
- Keep the footer below the main page content, in the normal document flow.
- On short pages that do not require scrolling, show it immediately.
- On longer pages, show it only when the user reaches the bottom.
- Do not keep it visible at other scroll positions.

### Search Controls
- Center the search bar and its adjacent **Browse by Tags** button as a group relative to the full page, not the space between other header elements.

### Glass Effects
- Increase header translucency slightly so content beneath it is easier to see. Preserve the glass appearance.
- Apply the same adjustment to the focus-reading dock, including the bottom dock containing the page title and **Exit Focus** control.
- Keep these glass effects consistent.

### Scroll Progress Indicator
- Retain the indicator below the header on both mobile and desktop.
- Reduce its contrast in light and dark modes. Use a softer, partially transparent line.

### Last-Updated Metadata
- Move the last-updated date, time, and username out of the page title and description container.
- Place them in a separate, narrow container between the share/notification box and the page-content columns.
- Use approximately the same height as the notification box above it. Consider a related color treatment.

## Page Editing

### Page Identity Image Selector
- Prevent long asset lists from extending beyond the viewport and becoming clipped.
- Constrain the selector height and allow internal scrolling.
- Ensure all assets remain accessible at normal browser zoom.

### Saving Animation
- Replace the original page-saving animation with the book animation used during sign-in.

## User Workspace

### Private Page Filter
- Add a filter that shows only private pages.
- Preserve the existing private-page indicators.
- Make private pages easier to find and manage.

## Wiki Agent Workspace

### Temporary Conversation Button
- Use the current hover appearance as the persistent active appearance after the button is clicked.
- Make the active state clearly distinct from the inactive state.
- Avoid an active appearance that resembles the adjacent **New** button and still looks ready to activate.

### Message Input
- Reduce the height of each of the four bottom controls by approximately 15% and the width by approximately 5%.
- Scale their text, icons, and spacing proportionally.
- Reduce the overall input-container height to match.

### Default Prompts
- Make each of the three default prompt cards approximately 5% wider and 10% shorter.
- Center the introductory heading above the prompt cards instead of left-aligning it.
- Remove the smaller supporting line about exploring ideas, connecting dots, or getting more from the wiki. It is redundant.

## Admin Workspace

### Navigation
- Keep **Knowledge**, **Intelligence**, and **Connection** collapsed by default, consistent with the other navigation categories.

### Workspace Overview
- Remove the **All Settings** section at the bottom. It duplicates the left navigation.

### Header
- Hide **Browse by Tags** throughout the admin area. It currently remains visible even when the search bar is absent.

## Browse by Tags

### Tag Icon Colors
- Expand the color palette to reduce repetition across alphabetic or alphanumeric groups.
- Use deterministic color assignment: provide varied colors while keeping each group’s color stable.
- Make icon colors more apparent in light mode. They currently appear almost like black outlines at a glance.
- Verify that colors remain distinct and readable in both themes.

## Login Page

### Theme Selection
- Make the login page follow the system light or dark preference when no saved user override is available.
- Do not depend on a signed-in user’s theme setting before authentication.