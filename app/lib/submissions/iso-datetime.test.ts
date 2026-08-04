import { describe, expect, it } from "vitest"
import { parseIsoDate, parseIsoDateTime } from "./iso-datetime"

describe("parseIsoDate", () => {
  it.each(["2026-08-04", "2024-02-29", "2000-02-29", "2026-12-31", "2026-01-01"])(
    "accepts %s",
    (value) => {
      expect(parseIsoDate(value)).not.toBeNull()
    }
  )

  it.each([
    "2025-02-29",
    "1900-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-01-32",
    "0000-01-01",
    "2026-8-04",
    "2026-08-04T00:00:00Z",
    "2026-08-04 ",
    "20260804",
    "Aug 4 2026",
    "",
  ])("rejects %s", (value) => {
    expect(parseIsoDate(value)).toBeNull()
  })

  it("does not roll an impossible day into the next month", () => {
    // Date.parse-based validation accepted this and stored it verbatim, so the
    // submission recorded a day that does not exist.
    expect(parseIsoDate("2025-02-30")).toBeNull()
  })
})

describe("parseIsoDateTime", () => {
  it("accepts the value an input[type=datetime-local] submits", () => {
    expect(parseIsoDateTime("2026-08-04T13:45")).toMatchObject({
      year: 2026,
      month: 8,
      day: 4,
      hour: 13,
      minute: 45,
      second: 0,
      millisecond: 0,
      offsetMinutes: null,
    })
  })

  it("reads seconds, fractional seconds and offsets", () => {
    expect(parseIsoDateTime("2026-08-04T13:45:30.250Z")).toMatchObject({
      second: 30,
      millisecond: 250,
      offsetMinutes: 0,
    })
    expect(parseIsoDateTime("2026-08-04T13:45:00+02:00")?.offsetMinutes).toBe(120)
    expect(parseIsoDateTime("2026-08-04T13:45:00-05:30")?.offsetMinutes).toBe(-330)
    expect(parseIsoDateTime("2026-08-04T13:45:00.1")?.millisecond).toBe(100)
  })

  it.each([
    "2026-02-30T00:00:00Z",
    "2026-08-04T24:00",
    "2026-08-04T23:60",
    "2026-08-04T23:59:60",
    "2026-08-04T13:45:00+24:00",
    "2026-08-04T13:45:00+02:60",
    "2026-08-04T13",
    "2026-08-04T13:45:00EST",
    "2026-08-04T13:45:00+0200",
    "2026-08-04",
    "next tuesday",
  ])("rejects %s", (value) => {
    expect(parseIsoDateTime(value)).toBeNull()
  })
})
