---
number: 1216
title: Tres WebGPU broken on three v181
type: bug
state: closed
created: 2025-11-01
url: "https://github.com/Tresjs/tres/issues/1216"
reactions: 3
comments: 2
labels: "[investigation, p4-important-bug]"
---

# Tres WebGPU broken on three v181

### Describe the bug

<img width="645" height="525" alt="Image" src="https://github.com/user-attachments/assets/f4b74e0f-80f6-40a7-98d0-d883e34e17fb" />

It start happen when update the version of threejs to the new 181

### Reproduction

https://stackblitz.com/edit/tresjs-minimal-reproduction-vcbxobzm?file=src%2FApp.vue

### Steps to reproduce

Is on stackblitz, if needed `npm install && npm run dev`

### System Info

```shell
npm, window, stackblitz


  "dependencies": {
    "@tresjs/core": "5.0.2",
    "@tresjs/leches": "^0.14.0",
    "three": "^0.181.0",
    "unocss": "^66.1.0-beta.5",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
```

### Used Package Manager

npm

### Code of Conduct

...

---

## Top Comments

**@alvarosabu** [maintainer]:

Three.js r181 introduced breaking changes to WebGPU renderer initialization (PR #24755):

  1. **Deprecated async methods**: `renderAsync()`, `computeAsync()`, `hasFeatureAsync()`, etc. were deprecated
  2. **Stricter initialization**: `await renderer.init()` is now **required** before calling any sync methods or setting properties
  3. **New recommended pattern**: Use `renderer.setAnimationLoop()` for automatic initialization, or explicitly `await renderer.init()` for manual control

  ### Why It Worked Before r181

...

**@edgexie**:

them error in windows11, chrome 142.0.7444.176, but on my mac chrome, there is not this error