---
number: 921
title: v5
type: other
state: closed
created: 2025-02-06
url: "https://github.com/Tresjs/tres/issues/921"
reactions: 3
comments: 5
labels: "[v5]"
---

# v5

### Description

This issue contains the discussion for the new major version v5.

## Goals 

- Stabilize ecosystem
- Improve the event handling system
- Reduce performance memory leaks
- WebGPU support
- Refactor several composables APIs

### Wishlist 

- useTresContextProvider orchestration separation of concerns into different composables
   - Rethink `useTresReady`
   - Move related logic to `useRenderer` https://github.com/Tresjs/tres/blob/90e1e94aac04681c4a428fcd7d139e444d33d789/src/composables/useTresContextProvider/index.ts#L112C2-L142C4
  - Move `setupDevtools` to TresCanvas
- Refactor `useTresContextProvider` createInjectionState https://vueuse.org/shared/createInjectionState/
- Refactor useRenderer
   - Don't recreate the renderer
   - Remove presets
   - Update renderer options...

---

## Top Comments

**@Tinoooo** [maintainer]:

We should basically check all composables whether they need refactoring. I just had a glimpse at `useLoop`. It manually sets the context to the loop created in the parent composable. It seems a bit error prone to me and could have a better architeture.

**@Tinoooo** [maintainer] (+1):

> So, when are you planning to support the features of WebGPU?

@daLeiStrive I answered your question before. WebGPU will be available with v5 (see this issue). See the sub-issues above.

**@alvarosabu** [maintainer]:

Hi @AntoninRousset is not inside of our Roadmap right now due to capacity constraints, but we are open to having a community package similar of pmndr's package https://github.com/pmndrs/react-three-offscreen 

Would you be available to help us build that?
