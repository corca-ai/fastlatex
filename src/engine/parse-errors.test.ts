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

  it('parses overfull hbox warning with line range', () => {
    const log = ['Overfull \\hbox (15.0pt too wide) in paragraph at lines 10--15', ' [] '].join(
      '\n',
    )

    const errors = parseTexErrors(log)
    expect(errors).toEqual([
      {
        line: 10,
        message: 'Overfull \\hbox (15.0pt too wide) in paragraph at lines 10--15',
        severity: 'warning',
      },
    ])
  })

  it('ignores underfull warnings (rarely actionable)', () => {
    const log = [
      'Underfull \\vbox (badness 10000) has occurred while \\output is active',
      ' [] at line 42',
      'Underfull \\hbox (badness 1215) in paragraph at lines 10--15',
      ' [] ',
    ].join('\n')

    const errors = parseTexErrors(log)
    expect(errors).toEqual([])
  })

  it('parses overfull hbox without line number', () => {
    const log = 'Overfull \\hbox (3.5pt too wide) detected\n\n'

    const errors = parseTexErrors(log)
    expect(errors).toEqual([
      {
        line: 0,
        message: 'Overfull \\hbox (3.5pt too wide) detected',
        severity: 'warning',
      },
    ])
  })

  it('parses box warnings alongside errors', () => {
    const log = [
      '! Undefined control sequence.',
      'l.5 \\badcmd',
      '',
      'Overfull \\hbox (10.0pt too wide) in paragraph at lines 20--25',
      ' [] ',
    ].join('\n')

    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(2)
    expect(errors[0]!.severity).toBe('error')
    expect(errors[0]!.line).toBe(5)
    expect(errors[1]!.severity).toBe('warning')
    expect(errors[1]!.line).toBe(20)
  })

  it('parses package error with line number', () => {
    const log = 'Package amsmath Error: Multiple \\tag on input line 42.\n'
    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.severity).toBe('error')
    expect(errors[0]!.line).toBe(42)
    expect(errors[0]!.message).toContain('[amsmath]')
    expect(errors[0]!.message).toContain('Multiple \\tag')
  })

  it('parses package error with lookahead line number', () => {
    const log = ['Package hyperref Error: No driver specified.', 'l.10 \\begin{document}'].join(
      '\n',
    )
    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.line).toBe(10)
  })

  it('parses package warning', () => {
    const log = 'Package natbib Warning: Citation `foo` undefined on input line 15.\n'
    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.severity).toBe('warning')
    expect(errors[0]!.line).toBe(15)
    expect(errors[0]!.message).toContain('[natbib]')
  })

  it('parses package warning without line number', () => {
    const log = 'Package hyperref Warning: Rerun to get /PageLabels entry.\n'
    const errors = parseTexErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.severity).toBe('warning')
    expect(errors[0]!.line).toBe(0)
  })
})
