---
number: 739
title: Color differences occur with useTexture
category: Q&A
created: 2024-06-20
url: "https://github.com/orgs/Tresjs/discussions/739"
upvotes: 0
comments: 2
answered: false
---

# Color differences occur with useTexture

useTexture uses threejs' Linear-sRGB color space, and the display effect is too bright than the actual image, how should I fix it?
After the texture is loaded：

Actual:



---

## Top Comments

**@zimuyanghua**:

How can I modify the color space, for example: "texture.encoding = THREE.sRGBEncoding", or "renderer.outputColorSpace = THREE.SRGBColorSpace". The following is an example of the code：

```
const pbrTexture = await useTexture({
  map: '/resource/aa.png'
})
```
   ```
<TresMesh>
    <TresPlaneGeometry :args="[9, 5]" />
    <TresMeshStandardMaterial :map="pbrTexture.map" :side="2" :transparent="true" :opacity="1">
    </TresMeshStandardMaterial>
  </TresMesh>
```

**@zimuyanghua**:

I solved the problem
`pbrTexture.map.colorSpace = THREE.SRGBColorSpace;`