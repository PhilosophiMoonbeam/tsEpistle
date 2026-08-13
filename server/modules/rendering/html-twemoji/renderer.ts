// const twemoji = require('twemoji')

// ------------------------------------
// HTML - Twemoji
// ------------------------------------

const plugin = {
  init(input: string, _config: Readonly<Record<string, unknown>>): string {
    void _config
    // TODO: Must limit to text nodes only (exclude code blocks, already processed emojis, etc.)
    //
    // return twemoji.parse(input)
    return input
  }
}

export default plugin
