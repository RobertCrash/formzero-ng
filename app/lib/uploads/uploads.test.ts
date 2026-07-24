import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { attachedObjectKey, temporaryObjectKey } from "./object-key"
import { sanitizeFilename, validateFiles } from "./validate-file"

describe("upload validation", () => {
  it("removes paths and unsafe filename characters", () => {
    expect(sanitizeFilename("../../private/<report>.pdf")).toBe("_report_.pdf")
    expect(sanitizeFilename("C:\\temp\\report.pdf")).toBe("report.pdf")
  })

  it("enforces MIME, extension, and size restrictions", () => {
    const policy = createDefaultFormPolicy()
    policy.uploads = {
      enabled: true,
      mode: "inline",
      maxFiles: 1,
      maxFileBytes: 5,
      maxTotalBytes: 5,
      allowedMimeTypes: ["text/plain"],
      allowedExtensions: [".txt"],
    }
    expect(() =>
      validateFiles(
        { attachment: [new File(["too large"], "file.txt", { type: "text/plain" })] },
        policy
      )
    ).toThrow()
    expect(() =>
      validateFiles(
        { attachment: [new File(["ok"], "file.exe", { type: "application/x-msdownload" })] },
        policy
      )
    ).toThrow()
  })

  it("uses random-id storage layouts without filenames", () => {
    expect(attachedObjectKey("contact", "file-id", new Date("2026-07-01"))).toBe(
      "forms/contact/2026/07/file-id"
    )
    expect(temporaryObjectKey("contact", "session-id", "file-id")).toBe(
      "_tmp/contact/session-id/file-id"
    )
  })
})
