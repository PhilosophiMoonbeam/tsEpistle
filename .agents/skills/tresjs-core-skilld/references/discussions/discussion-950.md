---
number: 950
title: Adding mesh objects dynamically with Vue's reactive objects.
category: Q&A
created: 2025-03-01
url: "https://github.com/orgs/Tresjs/discussions/950"
upvotes: 1
comments: 0
answered: false
---

# Adding mesh objects dynamically with Vue's reactive objects.

I was looking into incorporating Three.js into my Vue (or possibly Nuxt) project, and then found TresJS. I like the idea of making canvas, scenes and meshes declarative, without having to initialize them with extra lines of code. However, I want to add objects (meshes) to the scene dynamically; that is to say, spawn objects and add them to the scene anytime needed. I tried maintaining a Vue reactive object, containing all objects I want to render in the canvas, and then have the TresMesh component iterate through it (v-for), but it didn't seem to work as I expected.

The code is as below:
...