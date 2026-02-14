import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompileResult } from '../types'
import { CompileScheduler } from './compile-scheduler'
import type { TexEngine } from './tex-engine'

function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    success: true,
    pdf: new Uint8Array([1]),
    log: '',
    errors: [],
    compileTime: 100,
    ...overrides,
  }
}

function mockEngine(compileResult?: CompileResult): TexEngine {
  const result = compileResult ?? makeResult()
  return {
    init: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    setMainFile: vi.fn(),
    compile: vi.fn().mockResolvedValue(result),
    isReady: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('ready'),
    flushCache: vi.fn(),
    terminate: vi.fn(),
  }
}

function sched(
  engine: TexEngine,
  onResult: (result: CompileResult) => void,
  onStatus: (status: 'compiling') => void,
  opts?: { minDebounceMs?: number; maxDebounceMs?: number },
) {
  return new CompileScheduler(engine, onResult, onStatus, opts)
}

describe('CompileScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces compile calls', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 300 })

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(engine.compile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(engine.compile).toHaveBeenCalledTimes(1)
  })

  it('calls onResult after compile', async () => {
    const result = makeResult()
    const engine = mockEngine(result)
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 50 })

    scheduler.schedule()
    vi.advanceTimersByTime(50)
    await vi.advanceTimersByTimeAsync(0)

    expect(onResult).toHaveBeenCalledWith(result)
  })

  it('calls onStatusChange when compiling', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 50 })

    scheduler.schedule()
    vi.advanceTimersByTime(50)

    expect(onStatus).toHaveBeenCalledWith('compiling')
  })

  it('queues a pending compile if already compiling', async () => {
    let resolveCompile!: (result: CompileResult) => void
    const engine = mockEngine()
    ;(engine.compile as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<CompileResult>((r) => {
          resolveCompile = r
        }),
    )
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 0 })

    scheduler.schedule()
    vi.advanceTimersByTime(0)
    expect(engine.compile).toHaveBeenCalledTimes(1)

    scheduler.schedule()
    vi.advanceTimersByTime(0)

    resolveCompile(makeResult())
    await vi.advanceTimersByTimeAsync(0)

    expect(engine.compile).toHaveBeenCalledTimes(2)
  })

  it('cancel stops pending debounce', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 300 })

    scheduler.schedule()
    scheduler.cancel()
    vi.advanceTimersByTime(300)

    expect(engine.compile).not.toHaveBeenCalled()
  })

  it('does not compile when engine is not ready', () => {
    const engine = mockEngine()
    ;(engine.isReady as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 0 })

    scheduler.schedule()
    vi.advanceTimersByTime(0)

    expect(engine.compile).not.toHaveBeenCalled()
  })

  it('handles compile errors gracefully', async () => {
    const engine = mockEngine()
    ;(engine.compile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('WASM crash'))
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 0 })

    scheduler.schedule()
    vi.advanceTimersByTime(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(onResult).toHaveBeenCalledTimes(1)
    const result = onResult.mock.calls[0]![0] as CompileResult
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  // --- Generation counter tests ---

  it('discards stale compile results when generation advances', async () => {
    let resolveCompile!: (result: CompileResult) => void
    const engine = mockEngine()
    ;(engine.compile as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<CompileResult>((r) => {
          resolveCompile = r
        }),
    )
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = sched(engine, onResult, onStatus, { minDebounceMs: 0 })

    // Start first compile (generation 1)
    scheduler.schedule()
    vi.advanceTimersByTime(0)

    // User types again → generation advances to 2, sets pendingCompile
    scheduler.schedule()
    vi.advanceTimersByTime(0)

    // First compile finishes with stale generation
    resolveCompile(makeResult({ compileTime: 500 }))
    await vi.advanceTimersByTimeAsync(0)

    // Stale result should NOT be delivered
    expect(onResult).not.toHaveBeenCalled()

    // Second compile runs (from pendingCompile), resolve it
    resolveCompile(makeResult({ compileTime: 200 }))
    await vi.advanceTimersByTimeAsync(0)

    // This result IS current generation
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  // --- Adaptive debounce tests ---

  it('starts with minDebounceMs when no compile history', () => {
    const engine = mockEngine()
    const scheduler = sched(engine, vi.fn(), vi.fn(), { minDebounceMs: 200 })
    expect(scheduler.getDebounceMs()).toBe(200)
  })

  it('adapts debounce based on compile time', async () => {
    const engine = mockEngine(makeResult({ compileTime: 600 }))
    const onResult = vi.fn()
    const scheduler = sched(engine, onResult, vi.fn(), {
      minDebounceMs: 150,
      maxDebounceMs: 1000,
    })

    // First compile: compileTime=600 → debounce should become 300 (600*0.5)
    scheduler.schedule()
    vi.advanceTimersByTime(150)
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduler.getDebounceMs()).toBe(300)
  })

  it('clamps debounce to min', async () => {
    const engine = mockEngine(makeResult({ compileTime: 100 }))
    const scheduler = sched(engine, vi.fn(), vi.fn(), {
      minDebounceMs: 150,
      maxDebounceMs: 1000,
    })

    scheduler.schedule()
    vi.advanceTimersByTime(150)
    await vi.advanceTimersByTimeAsync(0)

    // 100 * 0.5 = 50, clamped to 150
    expect(scheduler.getDebounceMs()).toBe(150)
  })

  it('clamps debounce to max', async () => {
    const engine = mockEngine(makeResult({ compileTime: 5000 }))
    const scheduler = sched(engine, vi.fn(), vi.fn(), {
      minDebounceMs: 150,
      maxDebounceMs: 1000,
    })

    scheduler.schedule()
    vi.advanceTimersByTime(150)
    await vi.advanceTimersByTimeAsync(0)

    // 5000 * 0.5 = 2500, clamped to 1000
    expect(scheduler.getDebounceMs()).toBe(1000)
  })
})
