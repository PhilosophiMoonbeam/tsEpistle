---
number: 880
title: Slow intellisense/suggestions
type: other
state: open
created: 2024-12-07
url: "https://github.com/Tresjs/tres/issues/880"
reactions: 4
comments: 9
labels: "[dx, investigation]"
---

# Slow intellisense/suggestions

### Describe the bug

Hi, does anyone have problems with slow **IntelliSense/suggestions** in **VSCode** ? I’ve been trying to debug this issue in my large app for the past few days, where suggestions appear after **2-6 seconds**. After a long time, the only thing that helped was removing Three.js. Is anyone else facing this issue, or perhaps have a solution? 
Thanks.

with nuxt tresjs
https://github.com/user-attachments/assets/dc468410-fb08-4961-a6f9-b3102b24ab77

without nuxt tresjs
https://github.com/user-attachments/assets/596c61a6-4cc9-40cd-9994-6a415b4bc684

A clean project with only Nuxt and the Tres.js module is slow, and performance worsens as the project grows.

### Reproduction

https://stackblitz.com/edit/nuxt-starter-a3ltqbft?file=app.vue,package.json,nuxt.confi...

---

## Top Comments

**@Ardyon** (+1):

Created a simple reproduction repo here using `npx create-tres@latest`.

If you need more info, just ask and I'll add it to this thread or my repo.

<sub>Took a little longer to respond because I had to figure out how to embed video in markdown files (hevc, mkv, gif, blah blah).</sub>

**@colinscz** [maintainer]:

Hi @jojco, we recently updated the nuxt tresjs-module and the nuxt-starter. 

Could you please try it out with the latest nuxt-starter version and let us know if the issue still exists for you? 
Thanks!  

**@colinscz** [maintainer]:

Hi guys, thanks for reporting your issue. Would anyone of you be so kind to provide a minimal reproduction repository or Stackblitz with the issue in Tres v5? 

Thanks upfront! 🏽 