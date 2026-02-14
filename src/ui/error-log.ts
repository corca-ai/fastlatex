import type { TexError } from '../types'

export class ErrorLog {
  private container: HTMLElement
  private onClickError: (line: number) => void

  constructor(container: HTMLElement, onClickError: (line: number) => void) {
    this.container = container
    this.onClickError = onClickError
  }

  update(errors: TexError[], log: string): void {
    this.container.innerHTML = ''

    // Header
    const header = document.createElement('div')
    header.className = 'log-header'

    const label = document.createElement('span')
    label.textContent = 'Problems'

    if (errors.length > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = String(errors.length)
      label.appendChild(badge)
    }

    header.appendChild(label)

    const toggleBtn = document.createElement('button')
    toggleBtn.textContent = this.container.classList.contains('open') ? 'Hide' : 'Show'
    toggleBtn.style.cssText =
      'background:none;border:none;color:#999;cursor:pointer;font-size:12px;'
    toggleBtn.onclick = () => this.toggle()
    header.appendChild(toggleBtn)

    header.onclick = (e) => {
      if (e.target === header || e.target === label) this.toggle()
    }

    this.container.appendChild(header)

    // Show errors
    if (errors.length > 0) {
      this.container.classList.add('open')
      for (const err of errors) {
        const entry = document.createElement('div')
        entry.className = `log-entry ${err.severity}`
        const lineStr = err.line > 0 ? `L${err.line}: ` : ''
        entry.textContent = `${lineStr}${err.message}`

        if (err.line > 0) {
          entry.onclick = () => this.onClickError(err.line)
          entry.title = 'Click to jump to line'
        }

        this.container.appendChild(entry)
      }
    } else if (log) {
      // Show raw log as a single entry when no parsed errors
      const entry = document.createElement('div')
      entry.className = 'log-entry'
      // Show last meaningful lines of log
      const lastLines = log.split('\n').slice(-20).join('\n')
      entry.textContent = lastLines
      this.container.appendChild(entry)
    }
  }

  private toggle(): void {
    this.container.classList.toggle('open')
  }

  clear(): void {
    this.container.innerHTML = ''
    this.container.classList.remove('open')
  }
}
