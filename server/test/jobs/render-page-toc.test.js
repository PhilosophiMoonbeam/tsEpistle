const { buildTocFromHtml } = require('../../jobs/render-page-toc')

describe('jobs/render-page-toc/buildTocFromHtml', () => {
  it('builds a nested TOC and strips toc anchors from heading titles', () => {
    const html = [
      '<h1>Intro<a class="toc-anchor" href="#intro"></a></h1>',
      '<h2>Child<a class="toc-anchor" href="#child"></a></h2>',
      '<h2>Sibling<a class="toc-anchor" href="#sibling"></a></h2>',
      '<h3>Nested<a class="toc-anchor" href="#nested"></a></h3>'
    ].join('')

    expect(buildTocFromHtml(html)).toEqual([
      {
        title: 'Intro',
        anchor: '#intro',
        children: [
          {
            title: 'Child',
            anchor: '#child',
            children: []
          },
          {
            title: 'Sibling',
            anchor: '#sibling',
            children: [
              {
                title: 'Nested',
                anchor: '#nested',
                children: []
              }
            ]
          }
        ]
      }
    ])
  })

  it('treats h2 as top level when no h1 headings are present', () => {
    const html = [
      '<h2>Overview<a class="toc-anchor" href="#overview"></a></h2>',
      '<h3>Details<a class="toc-anchor" href="#details"></a></h3>'
    ].join('')

    expect(buildTocFromHtml(html)).toEqual([
      {
        title: 'Overview',
        anchor: '#overview',
        children: [
          {
            title: 'Details',
            anchor: '#details',
            children: []
          }
        ]
      }
    ])
  })
})
