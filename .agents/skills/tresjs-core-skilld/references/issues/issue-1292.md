---
number: 1292
title: Tree-shakable Three.js Imports for TresJS
type: other
state: open
created: 2026-01-29
url: "https://github.com/Tresjs/tres/issues/1292"
reactions: 3
comments: 3
---

# Tree-shakable Three.js Imports for TresJS

### Description

Currently, TresJS imports the entire Three.js namespace in `Context.vue` and registers all exports. This causes bundlers to include the **entire** Three.js library in the final build, even when the user only uses a small subset of Three.js objects.

For a typical start template provided by `pnpm create tres` with build config below:

```ts
  build: {
    minify: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              test: /\/three\//,
              name: 'three',
            },
          ],
        },
      },
    },
  },
```


```shell
vite v8.0.0-beta.11 building client environment for production...
✓ 43 modules transformed.
dist/index.html                               0.63 kB │ gzip:   0.36 kB
dist/assets/index-eDIznQ1E.css                0.13 kB │ gzip:   0.11 kB
dist/assets/rolldown-runtime-2YtBIAaz.js      0.31 kB │ gzip:   0.22 kB
dist/assets/index-DZHj7OJD.js               365.31 kB │ gzip:  88.65 kB
dist/assets/three-BurP11D-.js             1,152.04 kB │ gzip: 221.15 kB
```...

---

## Top Comments

**@alvarosabu** [maintainer] (+2):

Sorry Im just testing a bot that I created to help us summarise etc @Jungzl definitely something we should improve. Let me discuss it with the team

**@alvarosabu** [maintainer]:

@tresjs-cubebot wdyt?


**@tresjs-cube-bot**:

Hey @alvarosabu! 

Hey there!  Great analysis on the bundle size impact! Your detailed comparison showing the ~68KB reduction is super valuable. The two proposed solutions (manualExtend prop and auto-analysis plugin) are both interesting approaches. This is definitely something that could benefit the entire TresJS ecosystem for production builds. I'm just an AI cube, but I think a maintainer will find this proposal quite compelling with all the data you've provided! Thanks for taking the time to research and document this thoroughly! 

...