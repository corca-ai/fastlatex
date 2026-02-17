import * as pdfjsLib from 'pdfjs-dist'
import type { SynctexData } from '../synctex/synctex-parser'
import { SynctexParser } from '../synctex/synctex-parser'
import type { SourceLocation } from '../synctex/text-mapper'
import { TextMapper } from '../synctex/text-mapper'
import { PageRenderer } from './page-renderer'

// Single shared worker instance — avoids re-fetching pdf.worker.mjs on every render
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()
const pdfWorker = new pdfjsLib.PDFWorker()

export class PdfViewer {
  private container: HTMLElement
  private pdfDoc: pdfjsLib.PDFDocumentProxy | null = null
  private currentPage = 1
  private scale = 1.5
  private renderGeneration = 0
  private textMapper = new TextMapper()
  private synctexData: SynctexData | null = null
  private synctexParser = new SynctexParser()
  private onInverseSearch: ((loc: SourceLocation) => void) | null = null
  private pageObserver: IntersectionObserver | null = null
  private pageRenderer = new PageRenderer()
  private lastPdf: Uint8Array | null = null

  private loadingOverlay: HTMLElement | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.buildLoadingOverlay()
    this.buildControls()
  }

  /** Register callback for inverse search (Cmd/Ctrl+click on PDF → source location) */
  setInverseSearchHandler(handler: (loc: SourceLocation) => void): void {
    this.onInverseSearch = handler
  }

  /** Set source content for text-based inverse search (fallback) */
  setSourceContent(file: string, content: string): void {
    this.textMapper.setSource(file, content)
  }

  /** Set parsed SyncTeX data for precise PDF↔source sync */
  setSynctexData(data: SynctexData | null): void {
    this.synctexData = data
  }

  /** Get the last rendered PDF data for download. */
  getLastPdf(): Uint8Array | null {
    return this.lastPdf
  }

  private controlsEl!: HTMLElement
  private pageInfo!: HTMLSpanElement
  private pagesContainer!: HTMLElement

  private buildLoadingOverlay(): void {
    const overlay = document.createElement('div')
    overlay.className = 'pdf-loading-overlay'
    overlay.innerHTML =
      '<div class="pdf-loading-text">Loading engine...</div>' +
      '<div class="pdf-loading-bar"><div class="pdf-loading-bar-fill"></div></div>'
    this.container.appendChild(overlay)
    this.loadingOverlay = overlay
  }

  /** Update the loading overlay status. Hides overlay on first render. */
  setLoadingStatus(status: string): void {
    if (!this.loadingOverlay) return
    const text = this.loadingOverlay.querySelector('.pdf-loading-text')
    if (text) text.textContent = status
    const fill = this.loadingOverlay.querySelector<HTMLElement>('.pdf-loading-bar-fill')
    if (fill) {
      const widths: Record<string, string> = {
        'Loading engine...': '20%',
        'Compiling...': '50%',
        'Rendering PDF...': '80%',
      }
      fill.style.width = widths[status] ?? fill.style.width
    }
  }

  private removeLoadingOverlay(): void {
    if (this.loadingOverlay) {
      this.loadingOverlay.remove()
      this.loadingOverlay = null
    }
  }

  private buildControls(): void {
    this.controlsEl = document.createElement('div')
    this.controlsEl.className = 'pdf-controls'
    this.controlsEl.style.display = 'none'

    this.pageInfo = document.createElement('span')
    this.pageInfo.textContent = '0 / 0'

    const zoomOut = document.createElement('button')
    zoomOut.textContent = '-'
    zoomOut.onclick = () => this.zoom(-0.25)

    const zoomLabel = document.createElement('span')
    zoomLabel.className = 'zoom-label'
    zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
    zoomLabel.ondblclick = () => {
      this.scale = 1.0
      this.updateZoomLabel()
      if (this.pdfDoc) {
        const generation = ++this.renderGeneration
        this.renderAllPages(generation)
      }
    }
    this.zoomLabel = zoomLabel

    const zoomIn = document.createElement('button')
    zoomIn.textContent = '+'
    zoomIn.onclick = () => this.zoom(0.25)

    this.controlsEl.append(this.pageInfo, zoomOut, zoomLabel, zoomIn)
    this.container.appendChild(this.controlsEl)

    this.pagesContainer = document.createElement('div')
    this.container.appendChild(this.pagesContainer)

    // Single delegated click handler for inverse search — avoids duplicate
    // listeners that accumulate when canvases are recycled across renders.
    this.pagesContainer.addEventListener('click', (e) => {
      if (!this.onInverseSearch) return
      const target = e.target
      if (!(target instanceof HTMLCanvasElement)) return

      const wrapper = target.closest('.pdf-page-container') as HTMLElement | null
      if (!wrapper) return
      const pageNum = parseInt(wrapper.dataset.pageNum ?? '0', 10)
      if (pageNum === 0) return

      const rect = target.getBoundingClientRect()
      const x = (e.clientX - rect.left) / this.scale
      const y = (e.clientY - rect.top) / this.scale

      let loc: SourceLocation | null = null
      if (this.synctexData) {
        loc = this.synctexParser.inverseLookup(this.synctexData, pageNum, x, y)
      }
      if (!loc) {
        loc = this.textMapper.lookup(pageNum, x, y)
      }
      if (loc) this.onInverseSearch(loc)
    })
  }

  private zoomLabel!: HTMLSpanElement

  private updateZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
  }

  async render(pdfData: Uint8Array): Promise<number> {
    const start = performance.now()
    const generation = ++this.renderGeneration

    const oldDoc = this.pdfDoc

    // Keep a copy for download — pdf.js transfers the ArrayBuffer to its worker,
    // which detaches it, so we need a separate copy that stays valid.
    this.lastPdf = pdfData.slice()
    this.pdfDoc = await pdfjsLib.getDocument({ data: pdfData.slice(), worker: pdfWorker }).promise

    // Bail if a newer render was requested while loading
    if (generation !== this.renderGeneration) {
      this.pdfDoc.destroy()
      return performance.now() - start
    }

    this.removeLoadingOverlay()
    this.controlsEl.style.display = 'flex'

    // Clamp current page
    if (this.currentPage > this.pdfDoc.numPages) {
      this.currentPage = 1
    }

    await this.renderAllPages(generation)

    // Index text content for inverse search (skip when SyncTeX is available)
    if (generation === this.renderGeneration && !this.synctexData) {
      this.textMapper.clear()
      for (let i = 1; i <= this.pdfDoc.numPages; i++) {
        const page = await this.pdfDoc.getPage(i)
        await this.textMapper.indexPage(page, i)
      }
    }

    // Destroy old document after swap
    if (oldDoc) {
      oldDoc.destroy()
    }

    return performance.now() - start
  }

  private async renderAllPages(generation: number): Promise<void> {
    if (!this.pdfDoc) return

    const numPages = this.pdfDoc.numPages
    this.pageInfo.textContent = `Page ${this.currentPage} / ${numPages}`

    // Save old wrappers — reused as placeholders to keep previous content visible
    // instead of showing blank divs (prevents flicker on non-visible pages).
    const oldWrappers = Array.from(
      this.pagesContainer.querySelectorAll('.pdf-page-container'),
    ) as HTMLElement[]

    // Phase 1: Render the current (visible) page to a NEW offscreen canvas.
    // Don't recycle anything yet — old canvases are still visible in the DOM.
    const visiblePage = Math.min(this.currentPage, numPages)
    if (generation !== this.renderGeneration) return

    const firstResult = await this.pageRenderer.renderPage(this.pdfDoc, visiblePage, this.scale)
    if (generation !== this.renderGeneration) return

    const wrappers = this.buildPageWrappers(numPages, visiblePage, firstResult.wrapper, oldWrappers)
    this.swapPages(wrappers, visiblePage)

    // The visible page's old wrapper is now out of the DOM — safe to recycle its canvas
    const visibleOldCanvas = oldWrappers[visiblePage - 1]?.querySelector('canvas')
    if (visibleOldCanvas) this.pageRenderer.recycle([visibleOldCanvas as HTMLCanvasElement])

    // Phase 2: Render remaining pages to offscreen canvases, then swap atomically.
    // Recycle each old canvas only AFTER its wrapper leaves the DOM.
    for (let i = 1; i <= numPages; i++) {
      if (i === visiblePage) continue
      if (generation !== this.renderGeneration) return

      const result = await this.pageRenderer.renderPage(this.pdfDoc, i, this.scale)
      if (generation !== this.renderGeneration) return

      // Old wrapper's canvas is still in DOM — recycle after replacement
      const oldCanvas = wrappers[i - 1]?.querySelector('canvas')
      wrappers[i - 1]!.replaceWith(result.wrapper)
      wrappers[i - 1] = result.wrapper
      if (oldCanvas) this.pageRenderer.recycle([oldCanvas as HTMLCanvasElement])
    }

    // Re-observe after all pages are real
    this.observePages()
  }

  /** Build page wrapper elements (rendered page + old wrappers as placeholders) */
  private buildPageWrappers(
    numPages: number,
    visiblePage: number,
    renderedWrapper: HTMLElement,
    oldWrappers: HTMLElement[],
  ): HTMLElement[] {
    const wrappers = new Array<HTMLElement>(numPages)
    const canvas = renderedWrapper.querySelector('canvas')!
    const pageWidth = canvas.style.width
    const pageHeight = canvas.style.height
    for (let i = 1; i <= numPages; i++) {
      if (i === visiblePage) {
        wrappers[i - 1] = renderedWrapper
      } else if (oldWrappers[i - 1]) {
        // Reuse old wrapper to keep previous content visible (no blank flash)
        wrappers[i - 1] = oldWrappers[i - 1]!
      } else {
        // New page with no previous content — sized placeholder
        const placeholder = document.createElement('div')
        placeholder.className = 'pdf-page-container'
        placeholder.dataset.pageNum = String(i)
        placeholder.style.width = pageWidth
        placeholder.style.height = pageHeight
        wrappers[i - 1] = placeholder
      }
    }
    return wrappers
  }

  /** Swap page DOM and restore scroll position within the current page */
  private swapPages(wrappers: HTMLElement[], visiblePage: number): void {
    // Capture scroll position BEFORE building fragment — appendChild moves
    // old wrappers out of the DOM, which changes their offsetTop.
    const oldPageEl = this.pagesContainer.querySelector(
      `.pdf-page-container[data-page-num="${visiblePage}"]`,
    ) as HTMLElement | null
    const inPageOffset = oldPageEl ? this.container.scrollTop - oldPageEl.offsetTop : 0

    const fragment = document.createDocumentFragment()
    for (const w of wrappers) fragment.appendChild(w)

    this.pagesContainer.replaceChildren(fragment)

    const target = wrappers[visiblePage - 1]
    if (target) {
      this.container.scrollTop = target.offsetTop + inPageOffset
    }
    this.observePages()
  }

  /** Track which page is most visible via IntersectionObserver */
  private observePages(): void {
    if (this.pageObserver) {
      this.pageObserver.disconnect()
    }

    this.pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = parseInt((entry.target as HTMLElement).dataset.pageNum ?? '1', 10)
            this.currentPage = pageNum
            if (this.pdfDoc) {
              this.pageInfo.textContent = `Page ${pageNum} / ${this.pdfDoc.numPages}`
            }
          }
        }
      },
      { root: this.container, threshold: 0.5 },
    )

    for (const wrapper of this.pagesContainer.querySelectorAll('.pdf-page-container')) {
      this.pageObserver.observe(wrapper)
    }
  }

  private zoom(delta: number): void {
    this.scale = Math.max(0.5, Math.min(3, this.scale + delta))
    this.updateZoomLabel()
    if (this.pdfDoc) {
      const generation = ++this.renderGeneration
      this.renderAllPages(generation)
    }
  }

  /** Forward search: highlight a source location in the PDF */
  forwardSearch(file: string, line: number): void {
    let loc = this.synctexData
      ? this.synctexParser.forwardLookup(this.synctexData, file, line)
      : this.textMapper.forwardLookup(file, line)
    if (!loc) return

    // Find the page wrapper
    const pages = this.pagesContainer.querySelectorAll('.pdf-page-container')
    const pageEl = pages[loc.page - 1]
    if (!pageEl) return

    // Remove previous highlight
    for (const el of this.pagesContainer.querySelectorAll('.forward-search-highlight')) {
      el.remove()
    }

    // Create highlight overlay
    const highlight = document.createElement('div')
    highlight.className = 'forward-search-highlight'
    highlight.style.cssText = [
      'position: absolute',
      `left: ${loc.x * this.scale}px`,
      `top: ${loc.y * this.scale}px`,
      `width: ${Math.max(loc.width * this.scale, 200)}px`,
      `height: ${Math.max(loc.height * this.scale, 20)}px`,
      'background: rgba(255, 200, 0, 0.3)',
      'border: none',
      'pointer-events: none',
      'transition: opacity 0.5s',
    ].join(';')

    // Page wrapper needs relative positioning for absolute child
    ;(pageEl as HTMLElement).style.position = 'relative'
    pageEl.appendChild(highlight)

    // Scroll to the page
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Fade out after 2s
    setTimeout(() => {
      highlight.style.opacity = '0'
      setTimeout(() => highlight.remove(), 500)
    }, 2000)
  }
}
