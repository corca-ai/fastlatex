import { test, expect } from '@playwright/test'

test('engine.readFile returns .log after compilation', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#status')).toHaveText(/Ready/, { timeout: 30_000 })
  await expect(page.locator('.pdf-page-container canvas').first()).toBeVisible({ timeout: 10_000 })

  // Read the .log file via the exposed engine instance
  const log = await page.evaluate(async () => {
    const engine = (window as any).__engine
    return await engine.readFile('main.log')
  })

  expect(log).toBeTruthy()
  expect(typeof log).toBe('string')
  expect(log).toContain('main.tex')
})
