import type { VirtualFS } from '../fs/virtual-fs'

export class FileTree {
  private container: HTMLElement
  private activeFile: string = 'main.tex'
  private onSelect: (path: string) => void
  private fs: VirtualFS

  constructor(container: HTMLElement, fs: VirtualFS, onSelect: (path: string) => void) {
    this.container = container
    this.fs = fs
    this.onSelect = onSelect
    this.render()

    fs.onChange(() => this.render())
  }

  private render(): void {
    this.container.innerHTML = ''

    // Header
    const header = document.createElement('div')
    header.className = 'file-tree-header'

    const title = document.createElement('span')
    title.textContent = 'Files'

    const addBtn = document.createElement('button')
    addBtn.textContent = '+'
    addBtn.title = 'New file'
    addBtn.onclick = () => this.createFile()

    header.append(title, addBtn)
    this.container.appendChild(header)

    // File list
    const files = this.fs.listFiles()
    for (const path of files) {
      const item = document.createElement('div')
      item.className = `file-item${path === this.activeFile ? ' active' : ''}`
      item.textContent = path

      item.onclick = () => {
        this.activeFile = path
        this.onSelect(path)
        this.render()
      }

      // Delete button (not for main.tex)
      if (path !== 'main.tex') {
        const del = document.createElement('button')
        del.className = 'delete-btn'
        del.textContent = 'x'
        del.onclick = (e) => {
          e.stopPropagation()
          if (confirm(`Delete ${path}?`)) {
            this.fs.deleteFile(path)
            if (this.activeFile === path) {
              this.activeFile = 'main.tex'
              this.onSelect('main.tex')
            }
          }
        }
        item.appendChild(del)
      }

      this.container.appendChild(item)
    }
  }

  private createFile(): void {
    const name = prompt('File name (e.g. chapter1.tex):')
    if (!name || !name.trim()) return

    const path = name.trim()
    if (this.fs.getFile(path)) {
      alert('File already exists')
      return
    }

    this.fs.writeFile(path, '')
    this.activeFile = path
    this.onSelect(path)
  }

  setActive(path: string): void {
    this.activeFile = path
    this.render()
  }
}
