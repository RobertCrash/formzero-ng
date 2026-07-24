export function attachedObjectKey(
  formId: string,
  fileId: string,
  now = new Date()
) {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `forms/${formId}/${year}/${month}/${fileId}`
}

export function temporaryObjectKey(
  formId: string,
  uploadSessionId: string,
  fileId: string
) {
  return `_tmp/${formId}/${uploadSessionId}/${fileId}`
}
