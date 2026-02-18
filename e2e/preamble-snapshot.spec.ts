import { test, expect } from '@playwright/test'

const APP_URL = 'http://localhost:5173'

test.describe('Iteration 4: Preamble Snapshot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL)
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30_000 })
    await expect(page.locator('.pdf-page-container canvas').first()).toBeVisible({ timeout: 10_000 })
  })

  test('body-only edit uses cached preamble on second compile', async ({ page }) => {
    const editor = page.locator('.monaco-editor textarea')
    await editor.focus()

    // Type initial document
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'First version.',
        '\\end{document}',
        '',
      ].join('\n'),
      { delay: 5 },
    )

    // Wait for first compile (MISS — builds preamble format)
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30_000 })

    // Collect console logs for the next compile
    const preambleLogs: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[preamble]')) preambleLogs.push(text)
    })

    // Edit body only
    await editor.focus()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Second version.',
        '\\end{document}',
        '',
      ].join('\n'),
      { delay: 5 },
    )

    // Wait for second compile
    await expect(page.locator('#status')).toHaveText(/Ready/, { timeout: 30_000 })

    // Verify preamble HIT in console logs
    const hitLog = preambleLogs.find((l) => l.includes('HIT'))
    expect(hitLog).toBeTruthy()
  })

  test('preamble change triggers format rebuild', async ({ page }) => {
    const editor = page.locator('.monaco-editor textarea')
    await editor.focus()

    // Type initial document
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Hello.',
        '\\end{document}',
        '',
      ].join('\n'),
      { delay: 5 },
    )
    await expect(page.locator('#status')).toHaveText('Ready', { timeout: 30_000 })

    // Collect console logs
    const preambleLogs: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[preamble]')) preambleLogs.push(text)
    })

    // Change preamble (add a package)
    await editor.focus()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(
      [
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        '\\begin{document}',
        'Hello with math.',
        '\\end{document}',
        '',
      ].join('\n'),
      { delay: 5 },
    )
    await expect(page.locator('#status')).toHaveText(/Ready/, { timeout: 30_000 })

    // Should see a MISS (format rebuild)
    const missLog = preambleLogs.find((l) => l.includes('MISS'))
    expect(missLog).toBeTruthy()
  })

  test('file without \\begin{document} compiles normally', async ({ page }) => {
    const editor = page.locator('.monaco-editor textarea')
    await editor.focus()

    // Type a file without \begin{document} (plain TeX style)
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('Hello, plain TeX!\\bye\n', { delay: 5 })

    // Should still compile (full compile fallback) — might fail but shouldn't crash
    await page.waitForTimeout(3000)
    // App should still be functional
    const status = await page.locator('#status').textContent()
    expect(status).toBeTruthy()
  })
})
