import cash from 'cash-dom'
import { times } from 'lodash-es'

export default {
  format () {
    for (let i = 1; i < 6; i++) {
      cash(`.editor-markdown-preview-content h${i}.tabset`).each((idx, elm) => {
        elm.innerHTML = 'Tabset ( rendered upon saving )'
        cash(elm).nextUntil(times(i, t => `h${t + 1}`).join(', '), `h${i + 1}`).each((hidx, hd) => {
          hd.classList.add('tabset-header')
          cash(hd).nextUntil(times(i + 1, t => `h${t + 1}`).join(', ')).wrapAll('<div class="tabset-content"></div>')
        })
      })
    }
  }
}
