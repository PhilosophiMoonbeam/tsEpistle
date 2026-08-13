declare module 'mathjax' {
  interface MathJaxConfiguration {
    loader: {
      require: NodeJS.Require
      paths: { mathjax: string }
      load: string[]
    }
    tex: {
      packages: { '[+]': string[] }
    }
  }

  interface MathJaxApi {
    tex2svg(source: string, options: { display: boolean }): object
    startup: {
      adaptor: {
        innerHTML(node: object): string
      }
    }
  }

  interface MathJaxModule {
    init(configuration: MathJaxConfiguration): Promise<MathJaxApi>
  }

  const mathjax: MathJaxModule
  export default mathjax
}
