---
number: 1093
title: Auto import does not export components in components.d.ts ?
type: other
state: open
created: 2025-09-24
url: "https://github.com/Tresjs/tres/issues/1093"
reactions: 2
comments: 16
---

# Auto import does not export components in components.d.ts ?

### Describe the bug

I’m working on a threejs app using Nuxt. I noticed that the module automatically imports everything. However, I’m curious to know if it’s normal that no components of tresjs are exposed or exported into the auto-generated components.d.ts file of Nuxt. This would be beneficial for developers like me, as it would allow us to take advantage of the full autocompletion feature offered by most modern IDEs.

### Reproduction

https://stackblitz.com/~/github.com/EvanSchleret/tresjs-no-autocomplete-demo

### Steps to reproduce

Just open the demo and see that you don’t need to manually import the component. However, you don’t benefit from auto-completion of any component (including component props).

### System Info

...