declare module 'mathjax' {
  interface MathJaxConfiguration {
    loader: {
      require: NodeJS.Require
      paths: { mathjax: string, fonts: string }
      load: string[]
      failed(error: Error): never
    }
    tex: {
      packages: { '[+]': string[] }
    }
    startup: {
      output: 'svg'
    }
    output: {
      font: 'mathjax-newcm'
    }
    svg: {
      fontCache: 'none'
    }
  }

  export interface MathJaxApi {
    tex2svg(source: string, options: { display: boolean }): object
    startup: {
      document: {
        outputJax: {
          font: {
            loadDynamicFiles(): Promise<unknown[]>
          }
        }
      }
      adaptor: {
        innerHTML(node: object): string
      }
    }
  }

  export interface MathJaxModule {
    init(configuration: MathJaxConfiguration): Promise<MathJaxApi>
  }

  const mathjax: MathJaxModule
  export default mathjax
}
