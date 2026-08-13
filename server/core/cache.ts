import NodeCache from 'node-cache'

const cache = {
  init(): NodeCache {
    return new NodeCache()
  }
}

export default cache
