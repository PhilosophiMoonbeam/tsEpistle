import _ from 'lodash'
import type { CheerioAPI } from 'cheerio'

const plugin = {
  async init(
    $: CheerioAPI,
    _config: Readonly<Record<string, unknown>>
  ): Promise<void> {
    void _config
    for (let i = 1; i < 6; i++) {
      $(`h${i}.tabset`).each((_index, element) => {
        let content = '<tabset>'
        const tabs: string[] = []
        const tabContents: string[] = []
        $(element).nextUntil(_.times(i, t => `h${t + 1}`).join(', '), `h${i + 1}`).each((_headingIndex, heading) => {
          tabs.push(`<li>${$(heading).html()}</li>`)
          let tabContent = ''
          $(heading).nextUntil(_.times(i + 1, t => `h${t + 1}`).join(', ')).each((_contentIndex, contentElement) => {
            tabContent += $.html(contentElement)
            $(contentElement).remove()
          })
          tabContents.push(`<div class="tabset-panel">${tabContent}</div>`)
          $(heading).remove()
        })
        content += `<template v-slot:tabs>${tabs.join('')}</template>`
        content += `<template v-slot:content>${tabContents.join('')}</template>`
        content += '</tabset>'
        $(element).replaceWith($(content))
      })
    }
  }
}

export default plugin
