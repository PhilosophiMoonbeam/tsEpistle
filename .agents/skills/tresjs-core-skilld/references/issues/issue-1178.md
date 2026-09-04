---
number: 1178
title: Should not import utils functions
type: bug
state: open
created: 2024-10-25
url: "https://github.com/Tresjs/tres/issues/1178"
reactions: 0
comments: 0
labels: "[bug, p3-minor-bug, nuxt]"
---

# Should not import utils functions

### Describe the bug

Various functions of the @tresjs/core and @tresjs/cientos are being auto imported in my nuxt project resulting in conflicts with my definitions such as:
```
 WARN  Duplicated imports "pick", the one from "[...]" has been ignored and "@tresjs/cientos" is used
```

### Reproduction

https://stackblitz.com/~/edit/tres-nuxt-starter-z2w6ry-wbjcu5

### Steps to reproduce

Run `pnpm install` and watch the log for warning

### System Info

_No response_

### Used Package Manager

pnpm

### Code of Conduct

...