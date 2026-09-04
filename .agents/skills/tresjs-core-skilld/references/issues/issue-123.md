---
number: 123
title: Add i18n to Tresjs documentation
type: docs
state: closed
created: 2023-02-25
url: "https://github.com/Tresjs/tres/issues/123"
reactions: 2
comments: 4
labels: "[docs, discussion ]"
---

# Add i18n to Tresjs documentation

# description
 
To expand the project, it will be necessary to add translations in different languages, for this we need to create the base.
Currently there are intentions to add Spanish and Chinese.

## To discuss

We have several strategies to achieve this goal, but here I will expose two of them.

### 1. Using the current feature provide by vitepress (check it out)[https://vitepress.vuejs.org/guide/i18n] 

1. We need to make the redirection manually (explained in the link) through netlify
2. We need to reorganize the folder structure of the Docs 
3. Vitepress will make the rest for us
4. Currently I have found no projects using this feature

### 2. Using the I18n plugin

1. We need to install and setup the library
2. We don't need to update folders but we'll need to u...