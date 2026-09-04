---
number: 1123
title: "bug: build fails when NuxtUI module prop `global` is set to `true` and TresJS with cientos is present"
type: other
state: open
created: 2024-05-06
url: "https://github.com/Tresjs/tres/issues/1123"
reactions: 3
comments: 4
labels: "[cientos]"
---

# bug: build fails when NuxtUI module prop `global` is set to `true` and TresJS with cientos is present

### Describe the bug

If the following criteria are met in the project, the build command `pnpm build` will fail with the error below.

*Criteria:*

* The nuxt module `@tresjs/nuxt` is enabled in the project and present as dependency
* The dependency `@tresjs/cientos` is present (enabling in TresJS nuxt module config is not needed)
* The nuxt module `@nuxt/ui` is enabled in the project and present as dependency
* The NuxtUI module config `global` is set to `true`

*Error:*

Cannot use `pnpm build` bc the build fails with the following error:

...

---

## Top Comments

**@toddeTV** (+1):

BTW:
It is not needed to enable `@tresjs/cientos` in `nuxt.config.ts`:

```ts
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // [...]
  tres: {
    modules: [
      // '@tresjs/cientos', // <- not needed to encounter the problem
    ],
  },
})
```

**@TheAlexLichter** (+1):

The reason for this issue is an auto import name conflict. @tresjs/cientos provides `pick` as auto import which is then picked up via nuxt ui instead of the own `pick` - only in some components like `Radio`.

That's why it only appears when using `global: true` (all components made available) or when using distinct components.

As nuxt/ui defines `pick` (but uses non-script-setup CAPI) it might even be a ...

**@nwittwer**:

I'm also hitting the same error, even during development. Was able to reproduce that it seems like only once `@tresjs/cientos` is installed (via `package.json`) that the issue appears.

Appears to ONLY affect `URadio` and `URadioGroup` components, though? I'm able to use `UAlert`, `UButton`, `UToggle`, etc. without any issues, and without any configuration in `nuxt.config.ts` (no `global` option defined).

The error traces back to the same as yours above:
```
The left-hand side of an assignment expression must be a variable or a property access
...node_modules/@nuxt/ui/dist/runtime/components/forms/Radio.vue:128:68
```...