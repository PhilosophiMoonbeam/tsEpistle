---
number: 789
title: Portal
type: other
state: open
created: 2024-07-23
url: "https://github.com/Tresjs/tres/issues/789"
reactions: 2
comments: 1
labels: "[p3-significant]"
---

# Portal

### Description

As a developer using TresJS, I want to have a `<Portal>` component that can contain a separate `Scene` and `context`.

### Suggested solution

Provide a `<Portal>` component similar to R3F.

### Requirements

- [ ] Add override-able pointer to `TresContext` (Also add as prop to TresCanvas: see #581 ); use vanilla `THREE.Vector2`, accept `Vector2` and `UsePointerOptions` as TresCanvas prop
- [ ] Make these fields on `TresContext` swappable and (in some case injectable by the user): scene, camera, cameras, controls, raycaster, eventManager, sizes

### Validations

- [X] I agree to follow this project's Code of Conduct
- [X] Read the [Contributing Guidelines](https://github.com/Tresjs/tres/blob/mai...