---
number: 905
title: I get an error when using TresCanvas. Like this .. ( onUnmounted is called when there is no active component instance to be associated with. Lifecycle injection APIs can... )
type: bug
state: open
created: 2025-01-14
url: "https://github.com/Tresjs/tres/issues/905"
reactions: 4
comments: 2
labels: "[bug]"
---

# I get an error when using TresCanvas. Like this .. ( onUnmounted is called when there is no active component instance to be associated with. Lifecycle injection APIs can... )

### Describe the bug

If you just add TresCanvas to your code, you will get the error.
[Vue warn]: onUnmounted is called when there is no active component instance to be associated with. Lifecycle injection APIs can only be used during execution of setup(). If you are using async setup(), make sure to register lifecycle hooks before the first await statement.

sample of stackblitz has same problem too.


An error occurs even if you only add TresCanvas to a vue project without anything.

App.vue
```<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import HelloWorld from './components/HelloWorld.vue'
</script>

<template>
  <header>
    <img alt="Vue logo" class="logo" src="@/assets/logo.svg" width="125" height="125" />

    <div class="wrapper">
      <HelloWorld msg="You did it!" />

      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
      </nav>
    </div>
  </header>

  <RouterView />
</template>

<style scoped>

</style>
```...

---

## Top Comments

**@andretchen0** (+1):

@alvarosabu 

Looking at the call stack here, the warning originates in `useRaycaster`.

<img width="283" alt="Image" src="https://github.com/user-attachments/assets/75d58c78-03d7-43fd-ae79-a7b80fa02982" />

#844 – the new events system – doesn't use `useRaycaster`. Running #844 locally, the warning isn't reported, even after merging current `main`.

I've linked this issue to #844 so that it'll be closed when #844 is merged.




**@vincesp**:

See also https://github.com/Tresjs/tres/issues/886#issuecomment-3108942256