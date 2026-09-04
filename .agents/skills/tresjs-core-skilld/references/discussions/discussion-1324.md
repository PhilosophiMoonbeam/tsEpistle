---
number: 1324
title: "Proposal: Introducing a Plugin System for Tres.js"
category: General
created: 2026-02-04
url: "https://github.com/orgs/Tresjs/discussions/1324"
upvotes: 2
comments: 0
answered: false
---

# Proposal: Introducing a Plugin System for Tres.js

Hello everyone   

We’d like to open a discussion around the **creation of a potential plugin system for Tres.js**, with the goal of expanding our ecosystem in a scalable and maintainable way.

This is an early-stage proposal, and we’d love community feedback on **API design, ergonomics, and limitations**.

---

##  Motivation

As the Tres.js ecosystem grows, we see an opportunity to:

- Encourage **small, focused packages** that extend Tres.js
- Provide **official or semi-official integration points** for third-party libraries built for or commonly used with Three.js
- Avoid bloating core packages (and existing ones like `@tresjs/cientos`) with many third-party dependencies
- Make it easier for contributors to create and maintain extensions


###  Dependency Separa...