#!/usr/bin/env node
// Extract a compatible .fmt by running the app in a real browser (Playwright).
// The WASM worker builds the format on first compile and auto-downloads it.
//
// Prerequisites:
//   - texlive server running (docker compose up texlive)
//   - npx playwright install chromium (if not already)
//
// Usage: node scripts/extract-format.mjs
//
// The script starts Vite dev server, opens the app in Chromium, waits for
// the format to be built and downloaded, then copies it to public/swiftlatex/.

import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { copyFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outPath = join(root, 'public/swiftlatex/swiftlatexpdftex.fmt')

async function main() {
  // Check texlive server
  try {
    const r = await fetch('http://localhost:5001/pdftex/10/swiftlatexpdftex.fmt')
    if (!r.ok) throw new Error(`status ${r.status}`)
  } catch (e) {
    console.error('Texlive server not responding at localhost:5001.')
    console.error('Run: docker compose up texlive')
    process.exit(1)
  }

  console.log('Starting Vite dev server...')
  const server = await createServer({ root, configFile: join(root, 'vite.config.ts') })
  await server.listen()
  const addr = server.httpServer.address()
  const url = `http://localhost:${addr.port}`
  console.log(`Vite running at ${url}`)

  console.log('Launching browser...')
  const browser = await chromium.launch()
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()

  // Listen for the auto-download of swiftlatexpdftex.fmt
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 })

  page.on('console', msg => {
    const text = msg.text()
    if (text.includes('[compile]') || text.includes('[loadformat]') || text.includes('[engine]')) {
      console.log(`  [browser] ${text}`)
    }
  })

  console.log('Opening app — waiting for format build (this takes ~30-60s)...')
  await page.goto(url)

  // Wait for the format download
  const download = await downloadPromise
  const downloadPath = join(root, 'public/swiftlatex', download.suggestedFilename())
  await download.saveAs(downloadPath)

  console.log(`Format saved to ${downloadPath} (${(await download.createReadStream()).readableLength ?? '?'} bytes)`)

  // Verify
  if (existsSync(outPath)) {
    const { size } = await import('fs').then(fs => fs.statSync(outPath))
    console.log(`Verified: ${outPath} — ${size} bytes`)
  }

  await browser.close()
  await server.close()
  console.log('Done! Commit the updated .fmt file.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
