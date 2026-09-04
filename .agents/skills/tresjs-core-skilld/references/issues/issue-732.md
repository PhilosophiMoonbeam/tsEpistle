---
number: 732
title: Impossible to `inject` variable in canvas child component
type: feature
state: closed
created: 2024-06-10
url: "https://github.com/Tresjs/tres/issues/732"
reactions: 3
comments: 6
labels: "[feature, p3-significant]"
---

# Impossible to `inject` variable in canvas child component

### Describe the bug

I'm trying to `inject` a variable inside a component in a `TresCanvas`, but it's always `undefined`.

In the example i log the variable provided by the first component but in the `SecondTresjs` component, the variable is `undefined`

Am i doing something wrong? I cannot find anything in the docs about the context.

### Reproduction

https://stackblitz.com/edit/vitejs-vite-gtrfxh?file=src%2Fcomponents%2FFirstTresjs.vue

### Steps to reproduce

_No response_

### System Info

_No response_

### Used Package Manager

npm

### Code of Conduct

...

---

## Top Comments

**@alvarosabu** [maintainer] (+2):

> Does anyone have a final answer on how to deal with injected values in a Tree Scene ?

Hi @EvanSchleret we are currently discussing it internally, I personally see value in it. Let's see if it is feasible.

**@schplitt** (+3):

I think the problem lies with the custom Tresjs renderer. I think it loses the previous context from the default renderer.


The first time you inject it's actually `outside` the TresJS renderer thus still having access to the same context and there for the provided value.
The second time you inject the context has changed and the dependency injection does not have any value registered for the key `test`.

Notice if you inject a value in `SecondTresjs.vue` and add a child like `ThirdTresjs.vue` the provided value is correctly injected like in this Example:

Fwiw, if anyone would like to look into this, here's a slightly more minimal reproduction with some notes and a minimal on-screen test:

https://stackblitz.com/edit/vitejs-vite-5q8vs7?file=src%2FApp.vue