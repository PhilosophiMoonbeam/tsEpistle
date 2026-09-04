---
number: 540
title: Translate docs to multiple languages
type: question
state: open
created: 2024-02-07
url: "https://github.com/Tresjs/tres/issues/540"
reactions: 0
comments: 24
labels: "[docs, help wanted, feature, dx, p3-significant]"
---

# Translate docs to multiple languages

### Description

As a developer using TresJS I would like to have documentation available in my native language

This ticket is meant to keep track of the progress of multiple PRs to translate Tres docs:

- [x] Enable i18n and add Spanish docs done #123 #534 
- [x] Chinese translations @enpitsuLin #550 
- [x] German @DennisSmuda #548
- [ ] Polish @Dekier #546 
- [x] French @AminGtt #555 

Feel free to comment below if you would like to add your language and help us translate the docs.,

### Suggested solution

Create a branch `docs/translation-<language-unicode>` and a PR similar to #534 with the following steps:

1. Add a `<language-unicode>.ts` inside `docs/.vitepress/config` ex: `zh.ts` (copy the `en.ts` which is the original and then translate only what's needed.
2. ...