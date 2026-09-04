---
number: 883
title: WebGPU support
type: feature
state: closed
created: 2024-12-17
url: "https://github.com/Tresjs/tres/issues/883"
reactions: 2
comments: 4
labels: "[feature, p3-significant, v5]"
---

# WebGPU support

### Description

WebGPU Three.js r171 has been released and it’s a major milestone for WebGPU integration with third-party libraries such as React Three Fiber and bundlers like Vite or Next.js. We can now do this with zero configuration:

Three.js Vanilla Three.js

```ts
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
 
const renderer = new WebGPURenderer()
```

R3F

```ts
import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'
 
<Canvas gl={canvas => new WebGPURenderer({ canvas })}>
```

### Suggested solution

...