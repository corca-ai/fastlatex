import type { ProjectIndex } from '../lsp/project-index'
import type { SectionDef } from '../lsp/types'

const LEVEL_MAP: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
}

export class Outline {
  private container: HTMLElement
  private index: ProjectIndex
  private onSelect: (line: number) => void
  private currentFile: string = ''

  constructor(container: HTMLElement, index: ProjectIndex, onSelect: (line: number) => void) {
    this.container = container
    this.index = index
    this.onSelect = onSelect
  }

  update(filePath: string): void {
    this.currentFile = filePath
    this.render()
  }

  private render(): void {
    this.container.innerHTML = ''

    // Header
    const header = document.createElement('div')
    header.className = 'outline-header'
    header.textContent = 'Outline'
    this.container.appendChild(header)

    const symbols = this.index.getFileSymbols(this.currentFile)
    if (!symbols || symbols.sections.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'outline-empty'
      empty.textContent = 'No sections found'
      this.container.appendChild(empty)
      return
    }

    const list = document.createElement('div')
    list.className = 'outline-list'

    for (const section of symbols.sections) {
      const item = this.createItem(section)
      list.appendChild(item)
    }

    this.container.appendChild(list)
  }

  private createItem(section: SectionDef): HTMLElement {
    const item = document.createElement('div')
    item.className = 'outline-item'

    const level = LEVEL_MAP[section.level] ?? 2
    item.style.paddingLeft = `${12 + level * 12}px`

    const title = document.createElement('span')
    title.className = 'outline-title'
    title.textContent = section.title

    item.appendChild(title)

    item.onclick = () => {
      this.onSelect(section.location.line)
    }

    return item
  }
}
