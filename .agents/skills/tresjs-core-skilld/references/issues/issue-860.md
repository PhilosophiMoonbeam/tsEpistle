---
number: 860
title: "TresDirectionalLightHelper Uncaught (in promise): Cannot read properties of undefined (reading 'matrixWorld')"
type: bug
state: open
created: 2024-10-19
url: "https://github.com/Tresjs/tres/issues/860"
reactions: 2
comments: 2
labels: "[bug, p4-important-bug]"
---

# TresDirectionalLightHelper Uncaught (in promise): Cannot read properties of undefined (reading 'matrixWorld')

### Describe the bug

Can't seem to use TresDirectionalLightHelper in the simplest way.

### Reproduction

https://play.tresjs.org/#eNqdVW1P2zAQ/itW0MSmtUlaYNoyNrF2Y2MaAwHfCB9McjQGx7Zs922I/76z07QJMChro6q+l+eeO99dboMzDeaLUuFkDEES7JpMM2WJATtWhFMx+pQG1qTB51SwUkltyS0xBeVcTk/gityRKy1Lsonemw0LBzqkYkLN0mLPouzaRJnUsPmxYXukL5kdSmG15I+YMxBWGueRikwKYwlno8K64J8aTF6/ScVuVLFHrniwUCpOLeCJkN0GoykTuZx2DfsDJONAdTeTXGpMdON9/+tguOOzJfjxXsegjYLMsgkMaQmakkRJwyyTAl3OP3SIey7SgES1WzulpdihHYIp2gDdfofgEzuEREtLa0XcIYfUFuHxQaVdwNTJSAHfQZZg9ZwkVI+M8+l1SC/c6ZCtJp9G6DMpBYKCZpSTB2mvqEa1w9PckaJ7XLCMGtvF+8DStsMO5OwRno5k/fMirtv77vsfXLHGrtQPK3mqCtCrWq7NZH8wiLcGzzL5yrTrHiko/+U6l2i4Qve6i92t3yspstz23cCEBYGqOSp6Yb9d5XZf3Y/yA7gCvSp4Ha5DluX2c+EpV4OBot2oMTV4NHbO3d/ClryTikuZz8mt8ysRl4mExDiXhCia50yM6mMBLlhCenH8ygumLLfF8nyXig2qVAX0jC0h...

---

## Top Comments

**@andretchen0** (+2):

See also: `PlaneHelper`

https://stackblitz.com/edit/tresjs-minimal-reproduction-6rkjr6?file=src%2FApp.vue

```vue
<script setup lang="ts">
import { shallowRef } from 'vue';
import { TresCanvas } from '@tresjs/core';
import { OrbitControls } from '@tresjs/cientos';

const planeRef = shallowRef();
</script>

<template>
  <TresCanvas window-size clear-color="#82DBC5">
    <TresPerspectiveCamera :position="[9, 9, 9]" />
    <OrbitControls />
    <TresPlane ref="planeRef" />
    <TresPlaneHelper :args="[planeRef, 1, '#ffff00']" />
  </TresCanvas>
</template>
```

See console...

**@andretchen0**:

Here's a StackBlitz.

https://stackblitz.com/edit/tresjs-minimal-reproduction?file=src%2FApp.vue

```vue
<script setup lang="ts">
import { shallowRef } from 'vue';
import { DirectionalLight } from 'three';
import { TresCanvas } from '@tresjs/core';
import { OrbitControls } from '@tresjs/cientos';

const lightRef = shallowRef(new DirectionalLight());

setInterval(
  () => (lightRef.value.position.x = Math.sin(Date.now() * 0.01)),
  1000 / 60
);
</script>

<template>
  <TresCanvas window-size clear-color="#82DBC5">
    <TresPerspectiveCamera :position="[9, 9, 9]" />
    <OrbitControls />
    <TresMesh :position="[0, 0, 0]" cast-shadow>
      <TresBoxGeometry :args="[1.5, 1.5, 1.5]" />
      <TresMeshStandardMaterial />
    </TresMesh>
    <TresDirectionalLight
      ref="lightRef"
      :position="[-10, 10, 4]"
      :intensity="1.2"
      cast-shadow
    />
    <TresDirectionalLightHelper :args="[lightRef, 5]" />
  </TresCanvas>
</template>
```...