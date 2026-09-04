---
number: 484
title: Setting shadows using GLTFModel
category: Q&A
created: 2023-12-30
url: "https://github.com/orgs/Tresjs/discussions/484"
upvotes: 0
comments: 3
answered: true
---

# Setting shadows using GLTFModel

I'm trying to set shadow casting from a GLTF model imported using `GLTFModel` component. I wasn't able to find it mentioned in the docs, so I just naively added the `cast-shadows` attr.

```vue
<TresCanvas shadows>
  <TresDirectionalLight :position="[5, 10, 5]" :direction="[1, -2, 0]" cast-shadows />
  <GLTFModel path="path/to/model.gltf" cast-shadows />
  <Backdrop receive-shadow />
</TresCanvas>
```

This, however, just produce the following error:

```
Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'shadows')
    at tres.js:560:32
    at Array.reduce (<anonymous>)
    at patchProp (tres.js:560:15)
    at mountElement (runtime-core.esm-bundler.js:5293:11)
    at processElement (runtime-core.esm-bundler.js:5240:7)
    at patch (runtime-core.esm-bundler.js:5112:11)
    at ReactiveEffect.componentUpdateFn [as fn] (runtime-core.esm-bundler.js:5792:11)
    at ReactiveEffect.run (reactivity.esm-bundler.js:178:19)
    at instance.update (runtime-core.esm-bundler.js:5898:51)
    at setupRenderEffect (runtime-core.esm-bundler.js:5906:5)
```...

---

## Accepted Answer

**@JaimeTorrealba** [maintainer]:

Right now we have to add the reference, Then use the (Traverse)[https://threejs.org/docs/index.html?q=object#api/en/core/Object3D.traverse] function to tell all the meshes to add cast-shadow.
Something like:


 <TresCanvas shadows>
  <TresDirectionalLight :position="[5, 10, 5]" :direction="[1, -2, 0]" cast-shadows />
  <GLTFModel path="path/to/model.gltf" ref="myModelRef" />
  <Backdrop receive-shadow />
</TresCanvas>

But this seems like a big opportunity to improve how the GLTFModel  works, we could add a issue on cientos if you agree 