---
number: 675
title: Dev and prod (build) behavior mismatching - What did I do wrong?
category: Q&A
created: 2024-05-06
url: "https://github.com/orgs/Tresjs/discussions/675"
upvotes: 1
comments: 1
answered: false
---

# Dev and prod (build) behavior mismatching - What did I do wrong?

I just created a repo to test out/learn tresjs + three.js

I have successfully got an example of a boat rowing around with camera following in dev, however the build output just seems to silently fails.

---
Reproduction
https://github.com/NamesMT/3d-test

cd into `apps/frontend`
`pnpm install` => `pnpm run dev` => 127.0.0.1:3300 - Working
`pnpm run build` => `pnpm run preview` => 127.0.0.1:3000 - Only initial items renders without anything executed after that (no animation, no camera remount)

---

## Top Comments

**@NamesMT**:

Found an issue for this: https://github.com/Tresjs/nuxt/issues/97