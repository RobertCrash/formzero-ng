/**
 * Calendar-aware ISO 8601 date and date-time validation.
 *
 * `Date.parse` is the wrong tool here on two counts: anything it does not
 * recognise as an ISO string falls through to implementation-defined parsing,
 * and a component out of calendar range can roll over rather than fail, so
 * `2025-02-30` is accepted and silently means March 2nd. Submissions are stored
 * verbatim, so an accepted value must be a real instant on its own terms.
 */

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:\d{2})?$/

export type IsoDate = {
  year: number
  month: number
  day: number
}

export type IsoDateTime = IsoDate & {
  hour: number
  minute: number
  second: number
  millisecond: number
  /** Minutes east of UTC, or null when the value carries no offset. */
  offsetMinutes: number | null
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

export function parseIsoDate(value: string): IsoDate | null {
  const match = DATE_SHAPE.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1 || month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return { year, month, day }
}

export function parseIsoDateTime(value: string): IsoDateTime | null {
  const match = DATE_TIME_SHAPE.exec(value)
  if (!match) return null

  const date = parseIsoDate(`${match[1]}-${match[2]}-${match[3]}`)
  if (!date) return null

  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  // A leap second cannot be represented as an instant, and 24:00 is a valid ISO
  // spelling of the next midnight that would have to be rewritten to be stored.
  if (hour > 23 || minute > 59 || second > 59) return null

  const fraction = match[7]
  const millisecond = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"))

  let offsetMinutes: number | null = null
  const zone = match[8]
  if (zone !== undefined) {
    if (zone === "Z" || zone === "z") {
      offsetMinutes = 0
    } else {
      const offsetHour = Number(zone.slice(1, 3))
      const offsetMinute = Number(zone.slice(4, 6))
      if (offsetHour > 23 || offsetMinute > 59) return null
      offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute)
    }
  }

  return { ...date, hour, minute, second, millisecond, offsetMinutes }
}
