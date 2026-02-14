import * as pdfjsLib from 'pdfjs-dist'
import type { SourceLocation } from '../synctex/text-mapper'
import { TextMapper } from '../synctex/text-mapper'

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

export class PdfViewer {
  private container: HTMLElement
  private pdfDoc: pdfjsLib.PDFDocumentProxy | null = null
  private currentPage = 1
  private scale = 1.5
  private renderGeneration = 0
  private textMapper = new TextMapper()
  private onInverseSearch: ((loc: SourceLocation) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.buildControls()
  }

  /** Register callback for inverse search (Cmd/Ctrl+click on PDF → source location) */
  setInverseSearchHandler(handler: (loc: SourceLocation) => void): void {
    this.onInverseSearch = handler
  }

  /** Set source content for text-based inverse search */
  setSourceContent(file: string, content: string): void {
    this.textMapper.setSource(file, content)
  }

  private controlsEl!: HTMLElement
  private pageInfo!: HTMLSpanElement
  private pagesContainer!: HTMLElement

  private buildControls(): void {
    this.controlsEl = document.createElement('div')
    this.controlsEl.className = 'pdf-controls'
    this.controlsEl.style.display = 'none'

    const prevBtn = document.createElement('button')
    prevBtn.textContent = 'Prev'
    prevBtn.onclick = () => this.prevPage()

    this.pageInfo = document.createElement('span')
    this.pageInfo.textContent = '0 / 0'

    const nextBtn = document.createElement('button')
    nextBtn.textContent = 'Next'
    nextBtn.onclick = () => this.nextPage()

    const zoomOut = document.createElement('button')
    zoomOut.textContent = '-'
    zoomOut.onclick = () => this.zoom(-0.25)

    const zoomIn = document.createElement('button')
    zoomIn.textContent = '+'
    zoomIn.onclick = () => this.zoom(0.25)

    this.controlsEl.append(prevBtn, this.pageInfo, nextBtn, zoomOut, zoomIn)
    this.container.appendChild(this.controlsEl)

    this.pagesContainer = document.createElement('div')
    this.container.appendChild(this.pagesContainer)
  }

  async render(pdfData: Uint8Array): Promise<number> {
    const start = performance.now()
    const generation = ++this.renderGeneration

    const oldDoc = this.pdfDoc

    // Copy the data so the original ArrayBuffer isn't detached by postMessage
    const data = pdfData.slice()
    this.pdfDoc = await pdfjsLib.getDocument({ data }).promise

    // Bail if a newer render was requested while loading
    if (generation !== this.renderGeneration) {
      this.pdfDoc.destroy()
      return performance.now() - start
    }

    this.controlsEl.style.display = 'flex'

    // Clamp current page
    if (this.currentPage > this.pdfDoc.numPages) {
      this.currentPage = 1
    }

    await this.renderAllPages(generation)

    // Index text content for inverse search
    if (generation === this.renderGeneration) {
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

    this.pageInfo.textContent = `${this.pdfDoc.numPages} page${this.pdfDoc.numPages > 1 ? 's' : ''}`

    // Render into off-screen fragment
    const fragment = document.createDocumentFragment()

    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      // Bail if a newer render started
      if (generation !== this.renderGeneration) return

      const page = await this.pdfDoc.getPage(i)
      const viewport = page.getViewport({ scale: this.scale })

      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-page-container'

      const canvas = document.createElement('canvas')
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      await page.render({ canvasContext: ctx, viewport }).promise

      // Cmd/Ctrl+click → inverse search
      canvas.addEventListener('click', (e) => {
        if (!(e.metaKey || e.ctrlKey) || !this.onInverseSearch) return
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const x = (e.clientX - rect.left) / this.scale
        const y = (e.clientY - rect.top) / this.scale
        const loc = this.textMapper.lookup(i, x, y)
        if (loc) this.onInverseSearch(loc)
      })
      canvas.dataset.pageNum = String(i)

      wrapper.appendChild(canvas)
      fragment.appendChild(wrapper)
    }

    // Final staleness check before DOM swap
    if (generation !== this.renderGeneration) return

    // Preserve scroll position, swap in one shot
    const scrollTop = this.pagesContainer.scrollTop
    this.pagesContainer.replaceChildren(fragment)
    this.pagesContainer.scrollTop = scrollTop
  }

  private prevPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--
      this.scrollToPage(this.currentPage)
    }
  }

  private nextPage(): void {
    if (this.pdfDoc && this.currentPage < this.pdfDoc.numPages) {
      this.currentPage++
      this.scrollToPage(this.currentPage)
    }
  }

  private scrollToPage(page: number): void {
    const pages = this.pagesContainer.querySelectorAll('.pdf-page-container')
    const target = pages[page - 1]
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' })
    }
  }

  private zoom(delta: number): void {
    this.scale = Math.max(0.5, Math.min(3, this.scale + delta))
    if (this.pdfDoc) {
      const generation = ++this.renderGeneration
      this.renderAllPages(generation)
    }
  }

  clear(): void {
    this.pagesContainer.innerHTML = ''
    this.controlsEl.style.display = 'none'
    if (this.pdfDoc) {
      this.pdfDoc.destroy()
      this.pdfDoc = null
    }
  }
}
