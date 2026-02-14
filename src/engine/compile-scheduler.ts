import type { CompileResult } from '../types'
import type { TexEngine } from './tex-engine'

export class CompileScheduler {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private compiling = false
  private pendingCompile = false
  private debounceMs: number

  constructor(
    private engine: TexEngine,
    private onResult: (result: CompileResult) => void,
    private onStatusChange: (status: 'compiling') => void,
    debounceMs = 300,
  ) {
    this.debounceMs = debounceMs
  }

  schedule(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.runCompile()
    }, this.debounceMs)
  }

  private async runCompile(): Promise<void> {
    if (this.compiling) {
      this.pendingCompile = true
      return
    }

    if (!this.engine.isReady()) return

    this.compiling = true
    this.onStatusChange('compiling')

    try {
      const result = await this.engine.compile()
      this.onResult(result)
    } catch (err) {
      console.error('Compilation error:', err)
      this.onResult({
        success: false,
        pdf: null,
        log: String(err),
        errors: [{ line: 0, message: String(err), severity: 'error' }],
        compileTime: 0,
      })
    } finally {
      this.compiling = false

      if (this.pendingCompile) {
        this.pendingCompile = false
        this.runCompile()
      }
    }
  }

  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingCompile = false
  }
}
