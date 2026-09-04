---
number: 1121
title: <LOD />
type: other
state: closed
created: 2024-05-01
url: "https://github.com/Tresjs/tres/issues/1121"
reactions: 2
comments: 0
labels: "[p2-nice-to-have, cientos]"
---

# <LOD />

### Description

As a developer using Tres I would like to have different level of detailed mesh depending on the distance of the camera.

ThreeJs provide us with LOD. Which we can easily adapt it

### Suggested solution

Could be based on: https://github.com/pmndrs/drei#detailed

<TresDetailed :args="[0, 10, 20]">
    <TresMesh name="highPoly" />
    <TresMesh name="mediumPoly" />
    <TresMesh name="lowPoly" />
<TresDetailed>

Other alternatives are considered (I believe we can be a little more intuitive attaching the mesh directly and no by position)

### Alternative

Also, it could be a composable like useLevelOfDetail 

### Additional context

_No response_

### Validations

...