---
number: 252
title: Multiple instances of `useRenderLoop` per page share state
type: bug
state: closed
created: 2023-05-08
url: "https://github.com/Tresjs/tres/issues/252"
reactions: 2
comments: 6
labels: "[bug, help wanted, investigation]"
---

# Multiple instances of `useRenderLoop` per page share state

**Is your feature request related to a problem? Please describe.**

Use case is having multiple `<TresCanvas>` instances on one page which are individually pausable. Currently, pausing one instance results in all instances being paused.

**Describe the solution you'd like**

I think there's two possible solutions here:

- Each `useRenderLoop()` instance has its own state. It looks like this would have implications on the raycasting functionality, but that might be desirable?
- Each `<TresCanvas>` has its own state and providers or refs are used to tell `useRenderLoop` which to use

Each approach has their own pros and cons. I think each `<TresCanvas>` could have its own problems when third party Tres components try to do their own thing and affect the main app behaviour. It's al...

---

## Top Comments

**@alvarosabu** [maintainer] (+1):

Hi @callumacrae @andretchen0 to give a couple of thoughts regarding `useRenderLoop`

The original idea of the composable was to provide the user with an abstraction to replace the internal clock of ThreeJS that uses performance.now  and make it somehow reactive with useRafFn which uses `requestAnimationFrame`, so any abstraction in the ecosystem (cientos, postprocessing, physics) can react to changes and animate their objects or scenes. Any `Tres` component inside a unique `TresCanvas` sh...

**@alvarosabu** [maintainer]:

This functionality is now available by using the new `useLoop` composable which is bound to the state https://docs.tresjs.org/api/composables.html#useloop

**@andretchen0**:

Reviving this.

I agree with @callumacrae that each `useRenderLoop` should have its own state. 

# StackBlitz

Here's a StackBlitz showcasing the bug.

# Context

Most uses I've come across of `useRenderLoop` are for animating attributes. In that context, calling `pause()` and then *not* rerendering, e.g., when the screen is resized is counter to my intuition.

It seems like we need a separate **update** loop.

# Suggestions

## `useRenderLoop`

* Make `useRenderLoop` distinct *per `TresCanvas`* 

## Ne...