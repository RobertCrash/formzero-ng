import { describe, expect, it } from "vitest"
import {
  compileSafePattern,
  describePatternProblem,
  getSafePattern,
  testSafePattern,
} from "./safe-pattern"

const test = (pattern: string, input: string) =>
  testSafePattern(compileSafePattern(pattern), input)

describe("safe pattern matching", () => {
  it.each([
    ["^[A-Z]{2}\\d{4}$", "AB1234", true],
    ["^[A-Z]{2}\\d{4}$", "AB123", false],
    ["^[A-Z]{2}\\d{4}$", "ab1234", false],
    ["^\\d{3}-\\d{4}$", "555-1234", true],
    ["^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$", "user@example.com", true],
    ["^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$", "user@example", false],
    ["^\\+?[0-9 ]{7,20}$", "+44 20 7946 0958", true],
    ["^.{0,5}$", "abcde", true],
    ["^.{0,5}$", "abcdef", false],
    ["^[^@]+$", "no-at-sign", true],
    ["^[^@]+$", "has@sign", false],
    ["^\\w+$", "snake_case1", true],
    ["^\\s*$", "  \t ", true],
    ["^a?b$", "b", true],
    ["^a*$", "", true],
    ["^$", "", true],
    ["^$", "x", false],
  ])("matches %s against %s", (pattern, input, expected) => {
    expect(test(pattern, input)).toBe(expected)
  })

  it("searches anywhere when unanchored, as RegExp.test does", () => {
    expect(test("abc", "xxabcxx")).toBe(true)
    expect(test("abc", "xxabxx")).toBe(false)
    expect(test("\\d{3}", "order 4821 shipped")).toBe(true)
  })

  it("honours a trailing anchor without a leading one", () => {
    expect(test("abc$", "xxabc")).toBe(true)
    expect(test("abc$", "abcxx")).toBe(false)
  })

  it("returns in linear time on the input that defeats a backtracking engine", () => {
    // `new RegExp("^(a+)+$")` on this input does not terminate in any useful
    // time. Nested groups are rejected outright, and the equivalent flat
    // pattern is matched by simulating states rather than by backtracking.
    const input = `${"a".repeat(50_000)}b`
    const started = Date.now()
    expect(test("^a+a+a+a+$", input)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("caches a compiled pattern instead of rebuilding it per value", () => {
    expect(getSafePattern("^\\d+$")).toBe(getSafePattern("^\\d+$"))
  })
})

describe("rejected patterns", () => {
  it.each([
    ["^(a+)+$", "group"],
    ["^(?:ab)+$", "group"],
    ["^a|b$", "Alternation"],
    ["^(a)\\1$", "group"],
    ["^(?=x)a$", "group"],
    ["^\\bword\\b$", "word boundary"],
    ["^a{1,5000}$", "repetition above"],
    ["^[z-a]$", "range whose end"],
    ["^[a$", "unterminated character class"],
    ["^*$", "nothing to repeat"],
    ["a^b", "not at the start"],
    ["a$b", "not at the end"],
  ])("rejects %s", (pattern, reason) => {
    const problem = describePatternProblem(pattern)
    expect(problem).toBeTruthy()
    expect(problem!.toLowerCase()).toContain(reason.toLowerCase())
  })

  it("accepts the patterns a form owner is likely to write", () => {
    for (const pattern of [
      "^[A-Za-z ,.'-]{2,60}$",
      "^\\d{5}-?\\d{0,4}$",
      "^[0-9a-fA-F]{8}$",
      "\\.pdf$",
    ]) {
      expect(describePatternProblem(pattern)).toBeNull()
    }
  })
})
