---
number: 464
title: Enable usage of <Teleport>
type: question
state: open
created: 2023-12-05
url: "https://github.com/Tresjs/tres/issues/464"
reactions: 1
comments: 1
labels: "[help wanted, investigation]"
---

# Enable usage of <Teleport>

### Description

Sometimes I want to contain some shared logic for HTML User-Interface and 3d Content in the same component, for example the user clicks a `<button>` and something in the 3d scene acts accordingly. With the help of portal-vue or Teleport I have used this approach in the past, but with a custom made implementation of BabylonJS without using a custom renderer.

Example:
```vue
<template>
  <GLTFModel path="my-model.glb" v-if="isVisible" />
  
  <Teleport to="body">
    <button @click="isVisible.value = false">Hide GLTF</button>
  </Teleport>
</template>
```

### Suggested solution

Enable usage of portal-vue and/or Teleport. I have tried both, but they both throw different ki...

---

## Top Comments

**@Astanusic**:

Hello, I've been trying to implement a solution similar to what's offered by https://github.com/pmndrs/tunnel-rat.

Their implementation elegantly uses a Zustand store to manage an array of React nodes.
The key aspect is how it employs state changes to control the rendering process. The 'In' component adds child components to the store's array, and its mounting triggers a store version increment. This version change, managed by Zustand, is crucial as it prompts all consuming components to re-render, ensuring the updated rendering order aligns with user expectations. The 'Out' component then...