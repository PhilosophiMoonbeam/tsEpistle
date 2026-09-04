---
number: 1118
title: glTF KTX2.0 Texture support
type: other
state: open
created: 2024-02-23
url: "https://github.com/Tresjs/tres/issues/1118"
reactions: 2
comments: 1
labels: "[PR welcome, cientos]"
---

# glTF KTX2.0 Texture support

### Description

Currently `useGLTF` only supports Draco compressed glTF models. It would be very nice to also support KTX2.0 textures, as in three.js we have both: `.setDRACOLoader` and `.setKTX2Loader`.

### Suggested solution

Add `ktx2` and `transcoderPath` options in `useGLTF` and `GLTFModel`.

### Alternative

_No response_

### Additional context

_No response_

### Validations

- [X] I agree to follow this project's Code of Conduct
- [X] Read the Contributing Guidelines.
- [X] Read the docs.
- [X] Check that there isn't already an issue that reports the same bug to avoid creat...