import * as monaco from 'monaco-editor'
import { bibLanguage, bibLanguageConfig } from './bib-language'
import { latexLanguage, latexLanguageConfig } from './latex-language'

let languagesRegistered = false
let workersConfigured = false

/** Register LaTeX and BibTeX languages with Monaco. Safe to call multiple times.
 *  Exported so that host apps using an external editor can register syntax
 *  highlighting before creating their own Monaco instance. */
export function ensureLanguagesRegistered(): void {
  if (languagesRegistered) return
  languagesRegistered = true

  // Register LaTeX language
  monaco.languages.register({ id: 'latex' })
  monaco.languages.setMonarchTokensProvider('latex', latexLanguage)
  monaco.languages.setLanguageConfiguration('latex', latexLanguageConfig)

  // Register BibTeX language
  monaco.languages.register({ id: 'bibtex' })
  monaco.languages.setMonarchTokensProvider('bibtex', bibLanguage)
  monaco.languages.setLanguageConfiguration('bibtex', bibLanguageConfig)
}

/** Configure Monaco workers via Vite URLs. Only needed when FastLaTeX creates its own editor. */
function ensureWorkersConfigured(): void {
  if (workersConfigured) return
  workersConfigured = true

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
}

function ensureMonacoConfigured(): void {
  ensureWorkersConfigured()
  ensureLanguagesRegistered()
}

/** Create a Monaco text model for a project file. */
export function createFileModel(content: string, filePath: string): monaco.editor.ITextModel {
  ensureLanguagesRegistered()
  const lang = filePath.endsWith('.tex')
    ? 'latex'
    : filePath.endsWith('.bib')
      ? 'bibtex'
      : 'plaintext'
  const path = filePath.startsWith('/') ? filePath : `/${filePath}`
  const uri = monaco.Uri.file(path)
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
