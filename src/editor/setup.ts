import * as monaco from 'monaco-editor'
import { latexLanguage, latexLanguageConfig } from './latex-language'

let monacoConfigured = false

function ensureMonacoConfigured(): void {
  if (monacoConfigured) return
  monacoConfigured = true

  // Configure Monaco workers via Vite
  ;(self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
          { type: 'module' },
        )
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
        type: 'module',
      })
    },
  }

  // Register LaTeX language
  monaco.languages.register({ id: 'latex' })
  monaco.languages.setMonarchTokensProvider('latex', latexLanguage)
  monaco.languages.setLanguageConfiguration('latex', latexLanguageConfig)
}

/** Create a Monaco text model for a project file. */
export function createFileModel(content: string, filePath: string): monaco.editor.ITextModel {
  ensureMonacoConfigured()
  const lang = filePath.endsWith('.tex') ? 'latex' : 'plaintext'
  const uri = monaco.Uri.file(filePath)
  return monaco.editor.createModel(content, lang, uri)
}

/** Create the Monaco editor instance with an existing model. */
export function createEditor(
  container: HTMLElement,
  model: monaco.editor.ITextModel,
): monaco.editor.IStandaloneCodeEditor {
  ensureMonacoConfigured()
  return monaco.editor.create(container, {
    model,
    theme: 'vs-dark',
    fontSize: 14,
    lineNumbers: 'on',
    minimap: { enabled: false },
    wordWrap: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    tabSize: 2,
  })
}

export function revealLine(editor: monaco.editor.IStandaloneCodeEditor, line: number): void {
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}
