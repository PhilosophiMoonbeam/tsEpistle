---
number: 840
title: No access to controls when using useTresContext
type: other
state: open
created: 2024-09-24
url: "https://github.com/Tresjs/tres/issues/840"
reactions: 3
comments: 2
---

# No access to controls when using useTresContext

### Describe the bug

Adding OrbitControls in a child component and trying to have access to it in other components i would expect it works the same way as 'camera' by using TresContext.

controls just returns null.

### Reproduction

https://play.tresjs.org/#eNqdVW1v2zYQ/iuEgsEtZkuykxSb5g6Z3Xbo0DZB429VPzDS1WJCkQRJvy3If99RLzblJanaRLCte3nuuePx7j5YaDB/KRWuVxAkwdRkmilLDNiVIpyK5es0sCYN/kwFK5XUltwT5zKnYk0NeSDftCzJ4MKi7NZEmdQw+GNvuyiYzq9AGykawzDyZC6oZz0vGM/nslR7272ktUzFNKopIiF8sVAqTi3gGyFTj9iGiVxuRob9CyTjQPUok1xqzObkt8mb2fy8Song39QnGTXCRrWPfyR3gd4wDZllUlD+gS0LSxIlDXMCDPIlHpLJkJx9TQOSMGFBoGqHinE4QVFGjR2ZgiLFJuQ0OpBHwTTyMsNXY3fc/SxsyYepuJH5jtw7v5LqJRMJibE4hCia50ws29cCHLGEjOP4l0qwYbkt9u8PqTihStVA37El5IZmd0stVyKvS5mQkzh2cRAGD6UiGAyD+ixHJVXhLVYUe6qCTxsFtlJSB3Qyv22cIg0Ka5VJoijLBfrnwNlahwJsJFQZ...

---

## Top Comments

**@duc-ekahau** (+1):

Confirm this is a real bug and it happens for our case. In our case, we want to have some transition animation, so we are implementing moving the camera from top down to some certain x,y,z. However, we also have Orbit control in our screen, hence, we need to detect when the orbit control "starts" to stop the transition, otherwise, the camera will try to bounce back to x.y.z whenever the user move around with orbit control

**@kagula-light**:

这个还没有解决吗