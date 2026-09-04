---
number: 424
title: How does Tresjs compare to Lunchox
category: Q&A
created: 2023-10-20
url: "https://github.com/orgs/Tresjs/discussions/424"
upvotes: 1
comments: 2
answered: true
---

# How does Tresjs compare to Lunchox

Hello,
I was reading the documentation regarding the motivation of this library. I'm still not sure I understand how the v2 of Tresjs compares to Lunchbox since you decided to go for the same approach using a custom renderer and you are also actively contributeing to the latter. 
Thank you for any explanation 


---

## Accepted Answer

**@alvarosabu** [maintainer]:

Hi @mickaelchanrion thanks for your question.

Initially, Tres was not a custom renderer, but eventually, we got support from Cody from R3F to break down how we could use vue official custom renderer. The most noticeable difference with Lunchbox is that (at least at that time) it creates 2 vue app instances, each with its own renderer, and needs a reconciliation layer between both. Tres only creates one instance with bot vue and tres renderer coexisting. 

Also, Tres is meant to be an ecosystem, with the core as the base, of several packages (cientos, post-processing, physics) aiming to improve the DX. Is highly active and the team is working daily on the ecosystem. Lunchbox hasn't received any update in the last 6 months.

Hope this clears out a little bit.