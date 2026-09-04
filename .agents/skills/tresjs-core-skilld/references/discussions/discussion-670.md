---
number: 670
title: Proposal to Promote Best Practices in Using TresJS Library
category: General
created: 2024-04-30
url: "https://github.com/orgs/Tresjs/discussions/670"
upvotes: 2
comments: 0
answered: false
---

# Proposal to Promote Best Practices in Using TresJS Library


# Introduction
TresJS has been an invaluable tool in integrating Three.js with Vue, allowing developers to manage complex 3D scenes using a more declarative approach. Historically, our examples and documentation have emphasized a single-file component approach. While this method simplifies initial learning and setup, it may not promote the best practices for scalability and maintainability in larger applications.

# Problem Statement
The current single-file usage pattern encouraged by TresJS documentation and examples limits the scalability and maintainability of applications built with the library. Most composables require the context of the TresCanvas, making it cumbersome to manage larger, more complex scenes within a single file.

# Proposal
To address these limitations, we pr...