import type { CheerioAPI } from 'cheerio'

const plugin = {
  init(_$: CheerioAPI, _config: Readonly<Record<string, unknown>>): void {
    void _$
    void _config
  }
}

export default plugin
