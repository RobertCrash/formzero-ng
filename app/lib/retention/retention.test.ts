import { describe, expect, it } from "vitest"
import { csvValue } from "../delivery/process-export.server"
import { calculateDeleteAfter } from "./calculate-delete-after"

describe("retention timestamps", () => {
  it("keeps forever when null and calculates explicit expiry otherwise", () => {
    expect(calculateDeleteAfter(1_000, null)).toBeNull()
    expect(calculateDeleteAfter(1_000, 30)).toBe(
      1_000 + 30 * 86_400_000
    )
  })
})

describe("CSV safety", () => {
  it("escapes quotes and spreadsheet formulas", () => {
    expect(csvValue('a"b')).toBe('"a""b"')
    expect(csvValue("=IMPORTXML()")).toBe('"\'=IMPORTXML()"')
  })
})
