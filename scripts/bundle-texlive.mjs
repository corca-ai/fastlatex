#!/usr/bin/env node
// Bundle essential TeX files as static assets for gh-pages deployment.
// Captures texlive responses during compilation and saves them.
//
// Prerequisites: texlive server running (docker compose up texlive)
// Usage: node scripts/bundle-texlive.mjs

import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const bundleDir = join(root, 'public/texlive')

async function main() {
  // Check texlive server
  try {
    const r = await fetch('http://localhost:5001/pdftex/26/article.cls')
    if (!r.ok) throw new Error(`status ${r.status}`)
  } catch {
    console.error('Texlive server not responding. Run: docker compose up texlive')
    process.exit(1)
  }

  console.log('Starting Vite dev server...')
  const server = await createServer({ root, configFile: join(root, 'vite.config.ts') })
  await server.listen()
  const addr = server.httpServer.address()
  const url = `http://localhost:${addr.port}`

  const browser = await chromium.launch()
  const page = await browser.newPage()

  // Capture all texlive responses (including from Web Workers)
  const captured = new Map()
  page.on('response', async (response) => {
    const reqUrl = response.url()
    if (!reqUrl.includes('/texlive/')) return
    if (response.status() !== 200) return

    try {
      const body = await response.body()
      const path = reqUrl.replace(/.*\/texlive\//, '')
      if (!captured.has(path)) {
        captured.set(path, body)
      }
    } catch { /* response body may not be available */ }
  })

  let compiled = false
  page.on('console', msg => {
    const text = msg.text()
    if (text.includes('ExitStatus caught, code=0')) compiled = true
    if (text.includes('[compile]') && !text.includes('memlog')) {
      console.log(`  ${text}`)
    }
  })

  console.log('Opening app — waiting for compilation...')
  await page.goto(url)

  // Wait for two successful compilations (format build + actual compile + recompile)
  const deadline = Date.now() + 180_000
  let compileCount = 0
  while (compileCount < 2 && Date.now() < deadline) {
    if (compiled) { compileCount++; compiled = false }
    await new Promise(r => setTimeout(r, 500))
  }

  // Extra wait for trailing font requests
  await new Promise(r => setTimeout(r, 3000))

  console.log(`\nCaptured ${captured.size} texlive files.`)

  // Save files (skip .fmt which is handled separately)
  let saved = 0
  let totalSize = 0
  for (const [path, data] of captured) {
    if (path.endsWith('.fmt')) continue
    const outPath = join(bundleDir, path)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, data)
    totalSize += data.length
    saved++
  }

  console.log(`Saved ${saved} files (${(totalSize / 1024).toFixed(0)} KB) to public/texlive/`)

  await browser.close()
  await server.close()
  console.log('Done! Run: git add public/texlive && git commit')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
