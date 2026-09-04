---
number: 272
title: Support for Custom Renderers
type: question
state: closed
created: 2023-05-19
url: "https://github.com/Tresjs/tres/issues/272"
reactions: 4
comments: 4
labels: "[help wanted, investigation]"
---

# Support for Custom Renderers

### Description

As of now, https://github.com/Tresjs/tres/blob/main/src/composables/useRenderer/index.ts#L209  supports the default WebGL 2 renderer.

The idea would be to adapt `useRenderer` so a custom renderer like https://github.com/mrdoob/three.js/blob/dev/examples/jsm/renderers/webgpu/WebGPURenderer.js can be used.

### Suggested solution

Check out R3F and NGT support 

https://github.com/pmndrs/react-three-fiber/blob/master/packages/fiber/src/core/index.tsx#L108

<img width="1363" alt="image" src="https://github.com/Tresjs/tres/assets/4699008/3e13a42d-1e1f-4837-8d47-8887fc5dabef">


### Alternative

_No response_

### Additional context

_No response_

### Validations

- [X] I agree to follow this project's Code of Conduct:

I've been having a look at this. Depending on the level of support we want, this might be tricky. WebGPURenderer might be fine, but Tres seems to assume that the output element will be a canvas, which in the case of SVGRenderer, CSS2DRenderer, stuff like that, the output element is _not_ a canvas.

Looks like to truly support any renderer, we'd have to take the returned `domElement` and use that instead of providing our own.

Maybe it would be best to support only canvas-based renderers?

(R3F also only support canvas-based renderers)

Here's the interface for SVGRenderer: https://gith...

**@Tinoooo** [maintainer]:

A custom renderer can be used now.

**@callumacrae**:

Another complication - to use a canvas-based renderer, Tres needs to instantiate the renderer (because it has the canvas), but for an example like this, we need access to the renderer itself in the vue component.

I'm giving up for now - if anyone wants to pick it up in the future, here's what I tried so far :) https://github.com/callumacrae/tres/commit/a475a3f814932732883ebc69ac95babaf2cb14b1