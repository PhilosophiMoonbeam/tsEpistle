---
number: 724
title: Zoom In and Zoom Out Not Working in Production but Working Locally
category: Q&A
created: 2024-06-06
url: "https://github.com/orgs/Tresjs/discussions/724"
upvotes: 1
comments: 0
answered: false
---

# Zoom In and Zoom Out Not Working in Production but Working Locally

## Dependencies:
- "tresjs/cientos": "^3.8.0"
- "tresjs/core": "^3.7.0"
- "vue": "^3.4.20"
- pnpm: 9.0.6
- node: v20.11.1

## Issue:
In my project, I have an earth visualization feature that supports zooming in and out. This functionality was working fine previously. However, for the past 2-3 days, the zoom feature has stopped working in the production branches `release/dev` and `release/qa`. Interestingly, when I pull from `master`, `release/dev`, or `release/qa` and run the project locally on `localhost:5173`, the zoom feature works correctly. Yet, deploying the same branches results in the zoom functionality failing, while other functionalities continue to work properly.

## Steps Taken:
- I have made changes only to the frontend part of the project and have not touched the v...