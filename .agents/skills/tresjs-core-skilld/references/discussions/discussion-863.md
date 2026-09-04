---
number: 863
title: How to change property from ref?
category: Q&A
created: 2024-10-21
url: "https://github.com/orgs/Tresjs/discussions/863"
upvotes: 1
comments: 1
answered: true
---

# How to change property from ref?

I try to change
```
const splineMesh = meshRef.current;
const position = splineMesh.geometry.attributes.position;
position.setXYZ(i, point.x, point.y, point.z);
position.needsUpdate = true;
```

but I got warning from reactivity
`[Vue warn] Set operation on key "position" failed: target is readonly. `


how to properly change the properties?

---

## Accepted Answer

I'm going to close here and point you to the Tres Discord:

https://discord.com/invite/WYj3pjpPUK

It's a lot faster to get support over there.

To help people help you, please post a whole minimal example that produces the bug.