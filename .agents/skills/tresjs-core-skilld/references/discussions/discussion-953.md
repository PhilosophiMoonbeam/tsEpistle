---
number: 953
title: Export / Download current view as image
category: Q&A
created: 2025-03-04
url: "https://github.com/orgs/Tresjs/discussions/953"
upvotes: 1
comments: 1
answered: true
---

# Export / Download current view as image

Hi,

I'm looking at a way to download the current view as an image. There seems to be a way in Threejs but it requires access to the renderer.
Do you have such functionality included, or maybe a simple sample?

Thanks,
Norbert

---

## Accepted Answer

**@alvarosabu** [maintainer]:

Hi @nhuethmayr I made a small stackblitz https://stackblitz.com/~/edit/save-canvas-as-image?file=src%2FApp.vue with a simple download

```vue
<script setup lang="ts">
import { shallowRef, watch, ref } from 'vue'
import { TresCanvas } from '@tresjs/core'

import TheExperience from './components/TheExperience.vue'
const ctxRef = shallowRef()
const canvas = ref()

watch(ctxRef, (ctx) => {
  if(ctx.context.renderer.value) {
    canvas.value = ctx.context.renderer.value
  }
})

function downloadCanvas() {
  const dataURL = canvas.value.domElement.toDataURL('image/png');
    // Create a temporary link element
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = 'my3DView.png';
    link.click();
}


</script>

<template>
  <div class="absolute bottom-4 right-4 z-20 outline-none p-2 bg-white"> 
    <button @click="downloadCanvas">
      Download Canvas
    </button>
  </div>
  <TresCanvas
    ref="ctxRef"
    clear-color="#82DBC5"
    window-size
    preserve-drawing-buffer
  >
    <TheExperience />
  </TresCanvas>
</template>
```...