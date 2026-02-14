import * as pdfjsLib from 'pdfjs-dist'

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
  private rendering = false

  constructor(container: HTMLElement) {
    this.container = container
    this.buildControls()
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

    if (this.pdfDoc) {
      this.pdfDoc.destroy()
    }

    // Copy the data so the original ArrayBuffer isn't detached by postMessage
    const data = pdfData.slice()
    this.pdfDoc = await pdfjsLib.getDocument({ data }).promise
    this.controlsEl.style.display = 'flex'

    // Clamp current page
    if (this.currentPage > this.pdfDoc.numPages) {
      this.currentPage = 1
    }

    await this.renderAllPages()

    const renderTime = performance.now() - start
    return renderTime
  }

  private async renderAllPages(): Promise<void> {
    if (!this.pdfDoc || this.rendering) return
    this.rendering = true

    this.pagesContainer.innerHTML = ''
    this.pageInfo.textContent = `${this.pdfDoc.numPages} page${this.pdfDoc.numPages > 1 ? 's' : ''}`

    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
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

      wrapper.appendChild(canvas)
      this.pagesContainer.appendChild(wrapper)
    }

    this.rendering = false
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
      this.renderAllPages()
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
