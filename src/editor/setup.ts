import * as monaco from 'monaco-editor'
import { latexLanguage, latexLanguageConfig } from './latex-language'

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

export function createEditor(
  container: HTMLElement,
  initialContent: string,
  onChange: (content: string) => void,
): monaco.editor.IStandaloneCodeEditor {
  const editor = monaco.editor.create(container, {
    value: initialContent,
    language: 'latex',
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

  editor.onDidChangeModelContent(() => {
    onChange(editor.getValue())
  })

  return editor
}

export function setEditorContent(
  editor: monaco.editor.IStandaloneCodeEditor,
  content: string,
  language = 'latex',
): void {
  const model = editor.getModel()
  if (model) {
    model.dispose()
  }
  const newModel = monaco.editor.createModel(content, language)
  editor.setModel(newModel)
}

export function revealLine(editor: monaco.editor.IStandaloneCodeEditor, line: number): void {
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}
