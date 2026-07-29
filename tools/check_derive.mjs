/**
 * Assert that the JavaScript derivation reproduces the Python converter.
 *
 * src/lib/derive.js is a port of the derivation half of tools/convert_excel.py.
 * Two implementations of the same model will drift unless something holds them
 * together, and a drifted cooling fit does not look wrong — it just quietly
 * misprices every cycle length.
 *
 * So: strip the committed machines.json back to source data, rebuild the
 * payload from it in JS, and require the result to be identical to what Python
 * wrote. Any difference is a porting bug.
 *
 *   node tools/check_derive.mjs
 */
import { readFileSync } from 'node:fs'
import { buildPayload, extractSource } from '../src/lib/derive.js'

const expected = JSON.parse(readFileSync(new URL('../src/data/machines.json', import.meta.url)))
const actual = buildPayload(extractSource(expected))

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/** Walk both trees and report the first handful of differing paths. */
function diff(a, b, path = '', out = []) {
  if (out.length >= 8) return out
  if (a === b) return out
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9) out.push(`${path}: ${a} !== ${b}`)
    return out
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    out.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
    return out
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array/object mismatch`)
    return out
  }
  if (Array.isArray(a) && a.length !== b.length) {
    out.push(`${path}: length ${a.length} !== ${b.length}`)
    return out
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) out.push(`${path}.${key}: missing on the JS side`)
    else if (!(key in b)) out.push(`${path}.${key}: unexpected on the JS side`)
    else diff(a[key], b[key], `${path}.${key}`, out)
  }
  return out
}

console.log('\nderive.js reproduces convert_excel.py')

check(
  'same machines, in the same order',
  actual.machines.map((m) => m.id).join() === expected.machines.map((m) => m.id).join(),
  `${actual.machines.length} machine(s)`,
)

for (const want of expected.machines) {
  const got = actual.machines.find((m) => m.id === want.id)
  const d = got ? diff(got, want, want.id) : [`${want.id}: missing entirely`]
  check(`${want.name} derives identically`, d.length === 0, d.join('; '))
}

const ruleDiff = diff(actual.rules, expected.rules, 'rules')
check('rules parse identically', ruleDiff.length === 0, ruleDiff.join('; '))

const powerDiff = diff(actual.power, expected.power, 'power')
check('electricity block matches', powerDiff.length === 0, powerDiff.join('; '))

const unparsed = actual.rules.raw.filter((r) => !r.parsed)
check(
  'unparsed rules are still reported, never dropped',
  actual.rules.raw.length === expected.rules.raw.length,
  `${actual.rules.raw.length} sentence(s), ${unparsed.length} not understood`,
)

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
