import { describe, expect, it } from 'vitest'
import { parseTexErrors } from './parse-errors'

describe('parseTexErrors', () => {
  it('returns empty array for clean log', () => {
    const log = 'This is the output log.\nNo errors here.\n'
    expect(parseTexErrors(log)).toEqual([])
  })

  it('parses a TeX error with line number', () => {
    const log = ['! Undefined control sequence.', 'l.42 \\badcommand', ''].join('\n')

    const errors = parseTexErrors(log)
    expect(errors).toEqual([
      { line: 42, message: 'Undefined control sequence.', severity: 'error' },
    ])
  })

  it('parses a TeX error without line number', () => {
    const log = '! Emergency stop.\n\n'
    const errors = parseTexErrors(log)
    expect(errors).toEqual([{ line: 0, message: 'Emergency stop.', severity: 'error' }])
  })

  it('parses multiple errors', () => {
    const log = [
      '! Undefined control sequence.',
      'l.10 \\foo',
      '',
      '! Missing $ inserted.',
      'l.20 some text',
      '',
    ].join('\n')

    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(2)
    expect(errors[0]!.line).toBe(10)
    expect(errors[1]!.line).toBe(20)
  })

  it('parses LaTeX warnings with line numbers', () => {
    const log = "LaTeX Warning: Reference `fig:missing' on input line 15 undefined.\n"
    const errors = parseTexErrors(log)
    expect(errors).toEqual([
      {
        line: 15,
        message: "Reference `fig:missing' on input line 15 undefined.",
        severity: 'warning',
      },
    ])
  })

  it('parses LaTeX warnings without line numbers', () => {
    const log = 'LaTeX Warning: There were undefined references.\n'
    const errors = parseTexErrors(log)
    expect(errors).toEqual([
      { line: 0, message: 'There were undefined references.', severity: 'warning' },
    ])
  })

  it('parses mixed errors and warnings', () => {
    const log = [
      '! Undefined control sequence.',
      'l.5 \\badcmd',
      '',
      "LaTeX Warning: Citation `foo' on input line 12 undefined.",
      '',
    ].join('\n')

    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(2)
    expect(errors[0]!.severity).toBe('error')
    expect(errors[1]!.severity).toBe('warning')
  })

  it('handles empty log', () => {
    expect(parseTexErrors('')).toEqual([])
  })

  it('finds line number within 5-line lookahead window', () => {
    const log = [
      '! Missing $ inserted.',
      '<inserted text>',
      '                $',
      'l.99 some math here',
    ].join('\n')

    const errors = parseTexErrors(log)
    expect(errors[0]!.line).toBe(99)
  })
})
