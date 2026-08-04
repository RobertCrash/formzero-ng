/**
 * A restricted pattern language with linear-time matching.
 *
 * Field patterns are written by a form owner but run against public request
 * bodies, and `new RegExp(pattern).test(input)` uses JavaScript's backtracking
 * engine: `(a+)+$` against a long run of `a` costs exponential time, so a single
 * pattern turns every submission into a CPU exhaustion vector. Worse, the
 * pattern was recompiled per value.
 *
 * Rather than trying to detect dangerous regexes, this supports a subset with no
 * ambiguity to backtrack over — no groups, alternation, backreferences or
 * lookaround — and matches it by simulating all reachable states at once, which
 * is O(input x pattern) regardless of the pattern.
 */

export class UnsupportedPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedPatternError"
  }
}

type CharAtom = { kind: "char"; code: number }
type ClassAtom = { kind: "class"; negated: boolean; ranges: Array<[number, number]> }
type Atom = { kind: "any" } | CharAtom | ClassAtom

type Piece = { atom: Atom; min: number; max: number }

type CompiledPattern = {
  source: string
  pieces: Piece[]
  anchoredStart: boolean
  anchoredEnd: boolean
}

/**
 * Caps the simulated state space. Each piece contributes at most
 * `min(max, MAX_REPEAT) + 1` states, so this bounds the per-character work.
 */
const MAX_REPEAT = 1_000
const MAX_STATES = 4_000

const CLASS_SHORTHAND: Record<string, { negated: boolean; ranges: Array<[number, number]> }> = {
  d: { negated: false, ranges: [[48, 57]] },
  D: { negated: true, ranges: [[48, 57]] },
  w: {
    negated: false,
    ranges: [
      [48, 57],
      [65, 90],
      [95, 95],
      [97, 122],
    ],
  },
  W: {
    negated: true,
    ranges: [
      [48, 57],
      [65, 90],
      [95, 95],
      [97, 122],
    ],
  },
  s: {
    negated: false,
    ranges: [
      [9, 13],
      [32, 32],
      [0xa0, 0xa0],
      [0xfeff, 0xfeff],
    ],
  },
  S: {
    negated: true,
    ranges: [
      [9, 13],
      [32, 32],
      [0xa0, 0xa0],
      [0xfeff, 0xfeff],
    ],
  },
}

const ESCAPED_LITERALS: Record<string, number> = {
  t: 9,
  n: 10,
  r: 13,
  f: 12,
  v: 11,
  "0": 0,
}

function unsupported(what: string): never {
  throw new UnsupportedPatternError(
    `${what} is not supported in field patterns. Supported syntax: literals, ` +
      "character classes such as [A-Za-z0-9_-], the shorthands \\d \\w \\s and " +
      "their negations, `.`, the quantifiers ? * + {n} {n,} {n,m}, and the " +
      "anchors ^ and $."
  )
}

export function compileSafePattern(source: string): CompiledPattern {
  let index = 0
  const pieces: Piece[] = []
  let anchoredStart = false
  let anchoredEnd = false

  function readEscape(): CharAtom | ClassAtom {
    const char = source[index++]
    if (char === undefined) unsupported("A trailing backslash")
    if (char in CLASS_SHORTHAND) {
      return { kind: "class", ...CLASS_SHORTHAND[char] }
    }
    if (char in ESCAPED_LITERALS) {
      return { kind: "char", code: ESCAPED_LITERALS[char] }
    }
    if (char >= "1" && char <= "9") unsupported("A backreference")
    if (char === "b" || char === "B") unsupported("A word boundary")
    if (char === "u" || char === "x" || char === "c" || char === "p" || char === "P") {
      unsupported(`The escape \\${char}`)
    }
    return { kind: "char", code: char.charCodeAt(0) }
  }

  function readClass(): Atom {
    const negated = source[index] === "^"
    if (negated) index++
    const ranges: Array<[number, number]> = []
    let closed = false

    while (index < source.length) {
      if (source[index] === "]") {
        index++
        closed = true
        break
      }
      let low: number
      if (source[index] === "\\") {
        index++
        const atom = readEscape()
        if (atom.kind === "class") {
          // A shorthand inside a class contributes its own ranges. A negated
          // shorthand inside a class would need set subtraction, so it is out.
          if (atom.negated) unsupported("A negated shorthand inside a character class")
          ranges.push(...atom.ranges)
          continue
        }
        low = atom.code
      } else {
        low = source.charCodeAt(index++)
      }

      if (source[index] === "-" && source[index + 1] !== "]" && index + 1 < source.length) {
        index++
        let high: number
        if (source[index] === "\\") {
          index++
          const atom = readEscape()
          if (atom.kind !== "char") unsupported("A shorthand as a range endpoint")
          high = atom.code
        } else {
          high = source.charCodeAt(index++)
        }
        if (high < low) unsupported("A character range whose end precedes its start")
        ranges.push([low, high])
      } else {
        ranges.push([low, low])
      }
    }

    if (!closed) unsupported("An unterminated character class")
    if (ranges.length === 0) unsupported("An empty character class")
    return { kind: "class", negated, ranges }
  }

  function readQuantifier(): { min: number; max: number } {
    const char = source[index]
    if (char === "?") {
      index++
      return { min: 0, max: 1 }
    }
    if (char === "*") {
      index++
      return { min: 0, max: Infinity }
    }
    if (char === "+") {
      index++
      return { min: 1, max: Infinity }
    }
    if (char === "{") {
      const close = source.indexOf("}", index)
      if (close === -1) unsupported("An unterminated {n,m} quantifier")
      const body = source.slice(index + 1, close)
      const match = /^(\d+)(,(\d*)?)?$/.exec(body)
      if (!match) unsupported(`The quantifier {${body}}`)
      index = close + 1
      const min = Number(match[1])
      const max = match[2] === undefined ? min : match[3] ? Number(match[3]) : Infinity
      if (max < min) unsupported("A quantifier whose maximum is below its minimum")
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        unsupported(`A repetition above ${MAX_REPEAT}`)
      }
      return { min, max }
    }
    return { min: 1, max: 1 }
  }

  while (index < source.length) {
    const char = source[index]

    if (char === "^") {
      if (pieces.length > 0 || anchoredStart) unsupported("A `^` that is not at the start")
      anchoredStart = true
      index++
      continue
    }
    if (char === "$") {
      if (index !== source.length - 1) unsupported("A `$` that is not at the end")
      anchoredEnd = true
      index++
      continue
    }
    if (char === "(" || char === ")") unsupported("A group")
    if (char === "|") unsupported("Alternation")
    if (char === "*" || char === "+" || char === "?") {
      unsupported("A quantifier with nothing to repeat")
    }

    let atom: Atom
    if (char === ".") {
      index++
      atom = { kind: "any" }
    } else if (char === "[") {
      index++
      atom = readClass()
    } else if (char === "\\") {
      index++
      atom = readEscape()
    } else {
      index++
      atom = { kind: "char", code: char.charCodeAt(0) }
    }

    const { min, max } = readQuantifier()
    // A lazy marker changes which match is found, never whether one exists, and
    // only existence is asked here. Reaching this means a quantifier was just
    // consumed, so the `?` cannot belong to a following atom.
    if (source[index] === "?" && !(min === 1 && max === 1)) index++
    pieces.push({ atom, min, max })
  }

  const states = pieces.reduce(
    (total, piece) => total + Math.min(piece.max === Infinity ? piece.min : piece.max, MAX_REPEAT) + 1,
    1
  )
  if (states > MAX_STATES) {
    unsupported(`A pattern needing more than ${MAX_STATES} match states`)
  }

  return { source, pieces, anchoredStart, anchoredEnd }
}

function atomMatches(atom: Atom, code: number) {
  if (atom.kind === "any") return code !== 10 && code !== 13
  if (atom.kind === "char") return atom.code === code
  const inRange = atom.ranges.some(([low, high]) => code >= low && code <= high)
  return atom.negated ? !inRange : inRange
}

/**
 * State is `pieceIndex * (bound + 1) + repetitions`, tracked as a plain Set so
 * every reachable position advances together and nothing is ever re-explored.
 */
function encode(piece: number, count: number) {
  return piece * (MAX_REPEAT + 2) + count
}

export function testSafePattern(pattern: CompiledPattern, input: string) {
  const { pieces, anchoredStart, anchoredEnd } = pattern

  /** Follows the "this piece is satisfied" transitions without consuming input. */
  function close(states: Set<number>) {
    const queue = [...states]
    while (queue.length > 0) {
      const state = queue.pop()!
      const piece = Math.floor(state / (MAX_REPEAT + 2))
      const count = state % (MAX_REPEAT + 2)
      if (piece >= pieces.length) continue
      if (count >= pieces[piece].min) {
        const next = encode(piece + 1, 0)
        if (!states.has(next)) {
          states.add(next)
          queue.push(next)
        }
      }
    }
    return states
  }

  const accepting = encode(pieces.length, 0)
  let current = close(new Set([encode(0, 0)]))

  // An unanchored pattern may start at any offset, which is expressed by
  // re-seeding the start state at each step rather than by rescanning.
  if (!anchoredEnd && current.has(accepting)) return true

  for (let position = 0; position < input.length; position++) {
    const code = input.charCodeAt(position)
    const next = new Set<number>()

    for (const state of current) {
      const piece = Math.floor(state / (MAX_REPEAT + 2))
      if (piece >= pieces.length) continue
      const { atom, min, max } = pieces[piece]
      const count = state % (MAX_REPEAT + 2)
      if (count < max && atomMatches(atom, code)) {
        // Counting past min is only needed while max is finite.
        next.add(encode(piece, max === Infinity ? Math.min(count + 1, min) : count + 1))
      }
    }

    if (!anchoredStart) next.add(encode(0, 0))
    current = close(next)

    if (current.has(accepting)) {
      if (!anchoredEnd) return true
      if (position === input.length - 1) return true
    }
    if (current.size === 0) return false
  }

  return current.has(accepting)
}

/**
 * Compiled patterns, so a form's pattern is parsed once rather than per value.
 *
 * Keyed by the pattern text, which is a pure input, and capped so a churn of
 * distinct patterns cannot grow the isolate's memory without bound.
 */
const cache = new Map<string, CompiledPattern>()
const CACHE_LIMIT = 200

export function getSafePattern(source: string) {
  const cached = cache.get(source)
  if (cached) return cached
  const compiled = compileSafePattern(source)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(source, compiled)
  return compiled
}

/** Whether a pattern is expressible in this subset, for validating a policy. */
export function describePatternProblem(source: string) {
  try {
    compileSafePattern(source)
    return null
  } catch (error) {
    return error instanceof UnsupportedPatternError
      ? error.message
      : "This pattern could not be parsed."
  }
}
