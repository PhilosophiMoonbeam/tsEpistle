---
number: 371
title: Console Warnings and primitive using error
category: Q&A
created: 2023-08-18
url: "https://github.com/orgs/Tresjs/discussions/371"
upvotes: 1
comments: 3
answered: true
---

# Console Warnings and primitive using error

Thank you so much for supporting three Js in Vue. I'm trying to use it with Nuxt.
but I have some issues.
When I used GLTFModel, everything worked well.
but I get these warnings.
How do I get rid of them?

1 - Failed to resolve component: primitive
If this is a native custom element, make sure to exclude it from component resolution via compilerOptions.isCustomElement. 
  at <Component path="/assets/model/rhetorician/scene.gltf" draco="" position= Array(3)  ... > 
  at <T>

2- THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733.

<img width="1582" alt="Screenshot 2023-08-18 at 2 54 17 PM" src="https://github.com/Tresjs/tres/asse...

---

## Accepted Answer

**@alvarosabu** [maintainer]:

> THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733.

This is because of the threejs v155 update, you can ignore it
