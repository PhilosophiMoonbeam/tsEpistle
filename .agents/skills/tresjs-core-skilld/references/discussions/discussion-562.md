---
number: 562
title: "[Vue warn]: Failed to resolve component"
category: Q&A
created: 2024-02-24
url: "https://github.com/orgs/Tresjs/discussions/562"
upvotes: 1
comments: 0
answered: false
---

# [Vue warn]: Failed to resolve component

## before


## official solution
```js
// https://docs.tresjs.org/guide/getting-started.html
// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { templateCompilerOptions } from '@tresjs/core'

export default defineConfig({
  plugins: [
    vue({
      // Other config
      ...templateCompilerOptions
    }),
  ]
})
```
## after



package.json
```json
{
  "name": "vite-stock-manage-by-tres",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tresjs/cientos": "^3.8.0",
    "@tresjs/core": "^3.7.0",
    "@vueuse/core": "^10.8.0",
    "d3": "^7.8.5",
    "three": "^0.161.0",
    "tweakpane": "^4.0.3",
    "vue": "^3.4.19"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.4",
    "vite": "^5.1.4"
  }
}
```...