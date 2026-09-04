---
number: 596
title: How to customize each face of cube
category: Q&A
created: 2024-03-23
url: "https://github.com/orgs/Tresjs/discussions/596"
upvotes: 1
comments: 1
answered: true
---

# How to customize each face of cube

Hi!
I'm trying to customize each face of my cube with different colors (easy step, next step with textures), is it possible to achieve it like here in r3f  ?

```
   <TresMesh ref="cubeRef">
       <TresBoxGeometry />
       <TresMeshStandardMaterial attach="material" :color="material1" />
       <TresMeshStandardMaterial attach="material-1" :color="material2" />
       <TresMeshStandardMaterial attach="material-2" :color="material2" />
       <TresMeshStandardMaterial attach="material-3" :color="material2" />
       <TresMeshStandardMaterial attach="material-4" :color="material2" />
       <TresMeshStandardMaterial attach="material-5" :color="material2" />
   </TresMesh>
```

---

## Accepted Answer

Hey @LucaArgentieri 

The current version of Tres – to my knowledge – doesn't support pierced props for arrays, e.g., `attach="material-{arrayIndex}"`.

---

@alvarosabu Is this something to add to the core?

## Context

Here's how R3F handles e.g., "prop-0".