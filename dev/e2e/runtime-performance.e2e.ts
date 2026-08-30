import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { authenticateAsAdmin } from './helpers.ts'

const outputPath = process.env.RUNTIME_PERFORMANCE_FILE ?? 'runtime-performance.json'
const budgets = {
  cumulativeLayoutShift: Number(process.env.RUNTIME_MAX_CLS ?? 0.1),
  domContentLoadedMilliseconds: Number(process.env.RUNTIME_MAX_DCL_MS ?? 2500),
  interactionReadyMilliseconds: Number(process.env.RUNTIME_MAX_INTERACTION_MS ?? 2500),
  largestContentfulPaintMilliseconds: Number(process.env.RUNTIME_MAX_LCP_MS ?? 3000)
}

type SurfaceMetrics = {
  cumulativeLayoutShift: number
  domContentLoadedMilliseconds: number
  largestContentfulPaintMilliseconds: number
  responseStartMilliseconds: number
}

type RuntimePerformanceState = {
  cumulativeLayoutShift: number
  largestContentfulPaintMilliseconds: number
}

async function measureSurface(page: Page, path: string, readySelector: string): Promise<SurfaceMetrics> {
  await page.goto(path, { waitUntil: 'networkidle' })
  await page.locator(readySelector).first().waitFor({ state: 'visible' })
  await page.waitForTimeout(250)
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const state = (window as unknown as { __wikiRuntimePerformance: RuntimePerformanceState }).__wikiRuntimePerformance
    if (!navigation || !state) throw new Error('Runtime performance observers were not initialized')
    return {
      cumulativeLayoutShift: state.cumulativeLayoutShift,
      domContentLoadedMilliseconds: navigation.domContentLoadedEventEnd - navigation.startTime,
      largestContentfulPaintMilliseconds: state.largestContentfulPaintMilliseconds,
      responseStartMilliseconds: navigation.responseStart - navigation.startTime
    }
  })
}

type RuntimePerformanceViolation = {
  invariant: string
  surface: string
  measured: number
  threshold: number
}

function violatedRuntimeInvariants(surfaces: Record<string, SurfaceMetrics>, interactionReadyMilliseconds: number): RuntimePerformanceViolation[] {
  const violations: RuntimePerformanceViolation[] = []
  for (const [surface, metrics] of Object.entries(surfaces)) {
    if (metrics.domContentLoadedMilliseconds > budgets.domContentLoadedMilliseconds) {
      violations.push({
        invariant: 'domContentLoadedMilliseconds <= budgets.domContentLoadedMilliseconds',
        surface,
        measured: metrics.domContentLoadedMilliseconds,
        threshold: budgets.domContentLoadedMilliseconds
      })
    }
    if (metrics.largestContentfulPaintMilliseconds <= 0) {
      violations.push({
        invariant: 'largestContentfulPaintMilliseconds > 0',
        surface,
        measured: metrics.largestContentfulPaintMilliseconds,
        threshold: 0
      })
    }
    if (metrics.largestContentfulPaintMilliseconds > budgets.largestContentfulPaintMilliseconds) {
      violations.push({
        invariant: 'largestContentfulPaintMilliseconds <= budgets.largestContentfulPaintMilliseconds',
        surface,
        measured: metrics.largestContentfulPaintMilliseconds,
        threshold: budgets.largestContentfulPaintMilliseconds
      })
    }
    if (metrics.cumulativeLayoutShift > budgets.cumulativeLayoutShift) {
      violations.push({
        invariant: 'cumulativeLayoutShift <= budgets.cumulativeLayoutShift',
        surface,
        measured: metrics.cumulativeLayoutShift,
        threshold: budgets.cumulativeLayoutShift
      })
    }
  }
  if (interactionReadyMilliseconds > budgets.interactionReadyMilliseconds) {
    violations.push({
      invariant: 'viewToEditorMilliseconds <= budgets.interactionReadyMilliseconds',
      surface: 'view-to-editor',
      measured: interactionReadyMilliseconds,
      threshold: budgets.interactionReadyMilliseconds
    })
  }
  return violations
}

function writeReportAtomically(report: object): void {
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(temporaryPath, outputPath)
  } catch (error: unknown) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

test('keeps representative content and administration surfaces within runtime budgets', async ({ page }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    const state: RuntimePerformanceState = {
      cumulativeLayoutShift: 0,
      largestContentfulPaintMilliseconds: 0
    }
    ;(window as unknown as { __wikiRuntimePerformance: RuntimePerformanceState }).__wikiRuntimePerformance = state
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.largestContentfulPaintMilliseconds = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
        if (!entry.hadRecentInput) state.cumulativeLayoutShift += entry.value ?? 0
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })

  await authenticateAsAdmin(page)
  const surfaces = {
    content: await measureSurface(page, '/en/home', '.page-header-section'),
    dashboard: await measureSurface(page, '/a/dashboard', '.admin-main'),
    pages: await measureSurface(page, '/a/pages', '.admin-responsive-table')
  }

  await page.goto('/en/home', { waitUntil: 'networkidle' })
  const startedAt = Date.now()
  await page.getByRole('button', { name: /edit page/i }).click()
  await page.getByRole('button', { name: /save|saved/i }).waitFor({ state: 'visible' })
  const interactionReadyMilliseconds = Date.now() - startedAt

  const violatedInvariants = violatedRuntimeInvariants(surfaces, interactionReadyMilliseconds)
  const report = {
    schemaVersion: 1,
    status: violatedInvariants.length === 0 ? 'passed' : 'failed',
    budgets,
    surfaces,
    interactions: {
      viewToEditorMilliseconds: interactionReadyMilliseconds
    },
    violatedInvariants
  }
  writeReportAtomically(report)
  expect(report.violatedInvariants, 'runtime performance invariants').toEqual([])
})
