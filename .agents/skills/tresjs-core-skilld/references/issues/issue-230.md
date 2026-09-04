---
number: 230
title: "Support inline method in geometries ( EJ: toNonIndexed , setFromPoints)"
type: question
state: open
created: 2023-04-22
url: "https://github.com/Tresjs/tres/issues/230"
reactions: 0
comments: 7
labels: "[question, waiting for author]"
---

# Support inline method in geometries ( EJ: toNonIndexed , setFromPoints)

**Is your feature request related to a problem? Please describe.**
Currently, the toNonIndexed method 
doesn't work

**Describe the solution you'd like**
I would like to manipulate the vertex by nonIndexed geometries

**Suggested solution**
add a new prop to all geometries
Ej:
<BoxGeometry :args="[1,1,1, 10,10,10]" toNonIndexed />

**Additional context**
This is useful is you want to manipulate the vertex individually, in the vertex shader
