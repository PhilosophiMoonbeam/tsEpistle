---
number: 886
title: "Using TresJS with Astro : [Vue warn]: onUnmounted is called when there is no active component instance to be associated with..."
type: other
state: closed
created: 2024-12-20
url: "https://github.com/Tresjs/tres/issues/886"
reactions: 2
comments: 2
---

# Using TresJS with Astro : [Vue warn]: onUnmounted is called when there is no active component instance to be associated with...

### Describe the bug

Ran into this issue when trying to integrate TresJS in my Astro project. To verify that it wasn't me doing something stupid, I switched to Alvaro's tres-astro repository from the "How to add 3D to Astro using TresJS" video. I'm running into the same warning there. I also upgraded to the latest astro in the tres-astro repository, but still seeing the same error. As far as I can tell, the 3D model does show up. 

Removing the TheExperience component and just trying to use TresCanvas also triggers the same warning. 

```
(index):224  [Vue warn]: onUnmounted is called when there is no active component instance to be associated with. 
Lifecycle injection APIs can only be used during execution of setup(). 
If you are using async setup(), make sure to register lifecycle hooks before the first await statement.
```...