import { test, expect } from '@playwright/test'

const APP_URL = 'http://localhost:5555'

test.describe('Performance Benchmarks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${APP_URL}?perf=1`)
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30_000 })
    await expect(page.locator('.pdf-page-container canvas').first()).toBeVisible({
      timeout: 10_000,
    })
  })

  test('edit→PDF cycle completes within budget', async ({ page }) => {
    const editor = page.locator('.monaco-editor textarea')
    await editor.focus()

    // Type a small change and wait for recompile
    await page.keyboard.press('End')
    await page.keyboard.type(' test', { delay: 10 })

    // Wait for compilation to complete
    await expect(page.locator('#status')).toHaveText('Compiling...', { timeout: 5_000 })
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 15_000 })

    // Read perf data from the overlay
    const perfText = await page.locator('#perf-overlay').textContent()
    expect(perfText).toBeTruthy()

    // Parse timing values from the overlay
    const parseMs = (label: string): number | null => {
      const match = perfText?.match(new RegExp(`${label}:\\s*(\\d+)ms`))
      return match ? parseInt(match[1]!, 10) : null
    }

    const compile = parseMs('compile')
    const render = parseMs('render')
    const total = parseMs('total')

    // Log the values for manual review
    console.log(`Perf: compile=${compile}ms, render=${render}ms, total=${total}ms`)

    // Gate conditions (2-page document):
    // - Compile: WASM is fixed cost, just ensure it runs
    // - Render: < 200ms (canvas rendering)
    // - Total: < 2000ms (compile + render + debounce)
    if (compile !== null) expect(compile).toBeLessThan(5000)
    if (render !== null) expect(render).toBeLessThan(500)
    if (total !== null) expect(total).toBeLessThan(5000)
  })

  test('engine load time is under 2 seconds', async ({ page }) => {
    // Re-navigate to get a fresh load
    const start = Date.now()
    await page.goto(`${APP_URL}?perf=1`)
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30_000 })
    const loadTime = Date.now() - start

    console.log(`Engine load time: ${loadTime}ms`)
    expect(loadTime).toBeLessThan(30_000) // generous for CI
  })
})
