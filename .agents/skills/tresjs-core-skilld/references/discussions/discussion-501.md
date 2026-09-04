---
number: 501
title: Event bubbling
category: General
created: 2024-01-08
url: "https://github.com/orgs/Tresjs/discussions/501"
upvotes: 1
comments: 1
answered: false
---

# Event bubbling

# Meeting notes (2024-01-08)

with @garrlker @alvarosabu @Tinoooo 

* We want event bubbling (if the community agrees)
  * we currently don't have an idea what could be a better approach (or whether it even exists)
* We'll introduce event modifiers later (`.stop` and `.prevent`)
* @alvarosabu want's to check the behavior of other libraries first

---

## Top Comments

**@andretchen0** (+2):

Fwiw, Vue doesn't bubble component emitted events and the docs recommend the following approach in its place:

> If there is a need to communicate between sibling or deeply nested components, use an external event bus or a global state management solution.

https://vuejs.org/guide/components/events.html