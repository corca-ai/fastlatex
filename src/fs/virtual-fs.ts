import type { VirtualFile } from '../types'
import { deleteStoredFile, loadFiles, saveFile } from './persistent-fs'

const DEFAULT_TEX = `\\documentclass[twocolumn]{article}
\\usepackage{amsmath}
\\usepackage{amssymb}

\\title{A Brief Tour of Mathematics}
\\author{Browser \\LaTeX{} Editor}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}

This document demonstrates the browser-based \\LaTeX{} editor
with a two-column layout. It exercises various typesetting
features to test bidirectional SyncTeX navigation between
the source and the rendered PDF.

Paragraphs reflow naturally across two columns, making it
easy to verify that inverse search (clicking the PDF) and
forward search (moving the cursor in the editor) both
resolve to the correct source line.

\\section{Algebra}

The quadratic formula gives the roots of $ax^2 + bx + c = 0$:
\\begin{equation}
  x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\\end{equation}

For the cubic $x^3 + px + q = 0$, Cardano's formula yields:
\\begin{equation}
  x = \\sqrt[3]{-\\frac{q}{2} + \\sqrt{\\frac{q^2}{4} + \\frac{p^3}{27}}}
      + \\sqrt[3]{-\\frac{q}{2} - \\sqrt{\\frac{q^2}{4} + \\frac{p^3}{27}}}
\\end{equation}

\\section{Analysis}

Euler's identity $e^{i\\pi} + 1 = 0$ connects five
fundamental constants. More generally, Euler's formula states:
\\begin{equation}
  e^{i\\theta} = \\cos\\theta + i\\sin\\theta
\\end{equation}

The Gaussian integral evaluates to:
\\begin{equation}
  \\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
\\end{equation}

Taylor's theorem with remainder:
\\[
  f(x) = \\sum_{k=0}^{n} \\frac{f^{(k)}(a)}{k!}(x-a)^k + R_n(x)
\\]
where $R_n(x) = \\frac{f^{(n+1)}(c)}{(n+1)!}(x-a)^{n+1}$ for some
$c$ between $a$ and $x$.

\\section{Linear Algebra}

A $2 \\times 2$ matrix and its determinant:
\\[
  A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}, \\qquad
  \\det(A) = ad - bc
\\]

The eigenvalue equation $A\\mathbf{v} = \\lambda\\mathbf{v}$ leads to
the characteristic polynomial $\\det(A - \\lambda I) = 0$.

\\section{Number Theory}

\\begin{enumerate}
  \\item \\textbf{Fermat's Little Theorem.}
    If $p$ is prime and $\\gcd(a,p)=1$, then $a^{p-1} \\equiv 1 \\pmod{p}$.
  \\item \\textbf{Wilson's Theorem.}
    An integer $p > 1$ is prime if and only if $(p-1)! \\equiv -1 \\pmod{p}$.
  \\item \\textbf{Euler's Totient.}
    $\\phi(n) = n \\prod_{p \\mid n}\\left(1 - \\frac{1}{p}\\right)$.
\\end{enumerate}

The prime counting function $\\pi(x)$ satisfies:
\\[
  \\pi(x) \\sim \\frac{x}{\\ln x} \\quad \\text{as } x \\to \\infty
\\]

\\section{Probability}

Let $X$ be a continuous random variable with density~$f$.
\\begin{itemize}
  \\item \\textbf{Expectation:} $E[X] = \\int_{-\\infty}^{\\infty} x\\,f(x)\\,dx$
  \\item \\textbf{Variance:} $\\operatorname{Var}(X) = E[X^2] - (E[X])^2$
  \\item \\textbf{Normal:} $f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}}
    \\exp\\!\\left(-\\frac{(x-\\mu)^2}{2\\sigma^2}\\right)$
\\end{itemize}

The central limit theorem states that the sum of $n$
independent, identically distributed random variables
with finite variance converges in distribution to a normal:
\\[
  \\frac{\\bar{X}_n - \\mu}{\\sigma / \\sqrt{n}}
  \\xrightarrow{d} \\mathcal{N}(0,1)
\\]

\\section{Conclusion}

This document spans multiple pages in two-column layout,
providing a good test bed for SyncTeX-based navigation.
Click anywhere in the PDF to jump to the corresponding
source line, or move the cursor in the editor to
highlight the matching region in the PDF.

\\end{document}
`

export class VirtualFS {
  private files = new Map<string, VirtualFile>()
  private listeners: Array<() => void> = []
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private persistEnabled = false

  constructor() {
    this.writeFile('main.tex', DEFAULT_TEX)
  }

  /** Load persisted files from IndexedDB. Call once at startup before first compile. */
  async loadPersisted(): Promise<boolean> {
    const stored = await loadFiles()
    if (stored.length === 0) return false
    for (const { path, content } of stored) {
      this.files.set(path, { path, content, modified: true })
    }
    this.persistEnabled = true
    this.notify()
    return true
  }

  /** Enable automatic persistence to IndexedDB. */
  enablePersistence(): void {
    this.persistEnabled = true
  }

  writeFile(path: string, content: string | Uint8Array): void {
    this.files.set(path, { path, content, modified: true })
    this.notify()
    this.scheduleSave(path, content)
  }

  readFile(path: string): string | Uint8Array | null {
    return this.files.get(path)?.content ?? null
  }

  deleteFile(path: string): boolean {
    const deleted = this.files.delete(path)
    if (deleted) {
      this.notify()
      if (this.persistEnabled) deleteStoredFile(path)
    }
    return deleted
  }

  private scheduleSave(path: string, content: string | Uint8Array): void {
    if (!this.persistEnabled || typeof content !== 'string') return
    const existing = this.saveTimers.get(path)
    if (existing) clearTimeout(existing)
    this.saveTimers.set(
      path,
      setTimeout(() => {
        this.saveTimers.delete(path)
        saveFile(path, content)
      }, 500),
    )
  }

  listFiles(): string[] {
    return Array.from(this.files.keys()).sort()
  }

  getFile(path: string): VirtualFile | undefined {
    return this.files.get(path)
  }

  /** Get files that have been modified since last sync */
  getModifiedFiles(): VirtualFile[] {
    return Array.from(this.files.values()).filter((f) => f.modified)
  }

  /** Mark all files as synced */
  markSynced(): void {
    for (const file of this.files.values()) {
      file.modified = false
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}
