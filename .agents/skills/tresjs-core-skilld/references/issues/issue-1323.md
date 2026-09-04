---
number: 1323
title: Controls lag in Tres5 (unlike tres4) when there's a lot of objects
type: bug
state: closed
created: 2026-02-04
url: "https://github.com/Tresjs/tres/issues/1323"
reactions: 1
comments: 6
labels: "[bug, p4-important-bug, core]"
---

# Controls lag in Tres5 (unlike tres4) when there's a lot of objects

### Describe the bug

CameraControls used to be much smoother in Tres 4.
As more objects are added, the controls become noticeably slower in Tres 5.

### Reproduction

Tres 5 lag:
https://stackblitz.com/edit/tresjs-minimal-reproduction-3lfbz4gs?file=src%2FApp.vue

Tres 4 (with identical code) NO LAG:
https://stackblitz.com/edit/tresjs-minimal-reproduction-smcbc4zm?file=src%2FApp.vue

### Steps to reproduce

Create a large number of objects.

In the reproduction, change the count to 100 and then to 500, and observe the difference.

```function makeObjects({ seed = 424242, count = 500 } = {})```

### System Info

```shell
  System:
    OS: Linux 5.0 undefined
    CPU: (8) x64 Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz
    Memory: 0 Bytes / 0 Bytes
    Shell: 1.0 - /bin/jsh
  Binaries:
    Node: 20.19.1 - /usr/local/bin/node
    Yarn: 1.22.19 - /usr/local/bin/yarn
    npm: 10.8.2 - /usr/local/bin/npm
    pnpm: 8.15.6 - /usr/local/bin/pnpm
  npmPackages:
    @tresjs/cientos: ^5.3.0 => 5.3.0 
    @tresjs/core: ^5.4.0 => 5.4.0 
    three: ^0.182.0 => 0.182.0 
    vite: ^6.0.3 => 6.0.5 
    vue: ^3.5.27 => 3.5.27 
```...

---

## Top Comments

**@Tinoooo** [maintainer] (+2):

Thank you for the bug report and the excelent reproduction @MarioAda. Very helpful!

I found the cause for the bug. Here's a small explanation:
`CameraControls` uses `onBeforeRender` from `useLoop`, which is created by `useCreateRafLoop`. `useCreateRafLoop` called `clock.getDelta()` twice per frame (once for the before hook and once for the after hook). Since `Clock.getDelta()` returns the time since its last invocation and **resets its internal timer** on each call, the second call consumed the render time from the delta budget.
This caused the before hook's delta on the next frame to exclude...

**@MarioAda** (+2):

I added two reproduction URLs: one using Tres 4 (no lag) and one using Tres 5 (lag increases as more geometries are added).

I also included the system information from StackBlitz.

**@tresjs-cube-bot**:

<details>
<summary> CubeBot Analysis</summary>

**Issue Type:** Bug Report
**Package:** @tresjs/core
**Reproduction:**  Provided
**System Info:**  Missing
**Expected Behavior:**  Missing

**Summary:**
User reports camera controls becoming laggy in Tres5 compared to Tres4 when rendering many geometries (500+ objects), with performance degrading as geometry count increases.

**Labels added:** `waiting for author`, `core`

</details>