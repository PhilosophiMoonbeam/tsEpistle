---
number: 603
title: Issues and PRs by labels
category: General
created: 2024-03-27
url: "https://github.com/orgs/Tresjs/discussions/603"
upvotes: 1
comments: 8
answered: false
---

# Issues and PRs by labels

We are reaching a point where we need a proper prioritisation and categorisation workflow for new features and bugs across the ecosystem.

I got some advice from @patak-dev on how they label issues and PRs https://github.com/vitejs/vite/discussions/15857, I would like to apply something similar:

## Feedback
- `experimental`: Experimental feature

## Priorities
- `pending-triage`: ticket is pending to be prioritized 
- `p1-chore`: Doesn't change end-user code behavior (Ex. new linter, internal playground stuff)

### Bugs

- `p2-edge-case`: Bug, but has a workaround or limited in scope
- `p3-minor-bug`: An edge case that only affects very specific usage
- `p4-important`: Violate documented behavior or significantly improve performance
- `p5-urgent`: Fix build-breaking bugs a...

---

## Top Comments

**@alvarosabu** [maintainer]:

@Tresjs/core please provide feedback to start this task

**@andretchen0** (+2):

## Proposal

Eliminate "enhancement". Use "feat-*" instead.

## Reasoning

* The difference between "enhancement" and "feature" is subtle in many cases.
* Our new issue page doesn't make the distinction. 
* We don't allow "enhancement:" commit messages per Conventional commits, but we do allow "feat:".

**@alvarosabu** [maintainer]:

> It'd be nice to have a single way of formatting labels.

.  Especially due the escaping, agree.

