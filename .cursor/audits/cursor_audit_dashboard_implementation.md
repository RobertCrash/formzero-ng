# Audit dashboard implementation
_Exported on 7/24/2026 at 17:00:11 GMT+2 from Cursor (3.12.30)_

---

**User**

Review the newly implemented uncommitted changes in /home/robert/Work/Dev/Web/formzero-ng read-only. Focus on React Router nested settings routes, actions/loaders, form state, integration snippets, pagination/export, and security regressions. Identify concrete runtime or UX-blocking defects, exact file paths, and suggested fixes. Do not edit.

---

**Cursor**

[P1] Authenticate before writing Turnstile secrets — `app/routes/forms.$formId.settings.security.tsx:13`

The action calls `putSecret` before `savePolicyRequest` performs authentication. An unauthenticated POST can create secrets and potentially overwrite a supplied credential ID. Authenticate first, load the existing credential ID server-side, and enforce form/purpose ownership in `putSecret`.

[P1] Preserve the live secret when policy saving conflicts — `app/routes/forms.$formId.settings.security.tsx:38`

A stale tab overwrites the existing secret before the revision check. If policy saving returns 409, the failed request still changed the live credential, potentially breaking every CAPTCHA submission. Write a new secret ID and atomically commit its policy reference, cleaning it up on failure.

[P1] Enforce extension restrictions for direct uploads — `app/routes/api.forms.$formId.uploads.tsx:72`

Direct-upload sessions validate size and MIME type but never `allowedExtensions`; attachment also omits that validation. Files forbidden in inline mode are therefore accepted in direct mode. Reuse normalized extension validation during session creation and attachment.

[P1] Provide a usable asynchronous export flow — `app/routes/forms.$formId.submissions.export.tsx:46`

For more than 5,000 submissions, the ordinary export link receives a 202 JSON document and leaves the user there. Nothing polls `downloadUrl` or initiates the finished download. Start exports through a fetcher/action, display progress, poll status, then trigger the download.

[P2] Make the JavaScript snippet satisfy active policy — `app/routes/forms.$formId.integration.tsx:108`

The snippet always submits JSON and never includes `cf-turnstile-response`. It deterministically fails when CAPTCHA is enabled or JSON has been removed from allowed content types. Generate the appropriate encoding and include the enabled security fields.

[P2] Do not present direct-upload HTML as functional — `app/routes/forms.$formId.integration.tsx:91`

In direct mode the HTML still renders file inputs, but does not upload them or supply `_fz_upload_tokens`; required file fields therefore fail submission. Omit direct-upload file fields from this example or generate the complete session/upload/complete workflow.

[P2] Stream large CSV exports — `app/lib/delivery/process-export.server.ts:49`

Although rows are paginated from D1, every CSV line is accumulated in memory before R2 upload. Large exports can exceed Worker memory. Stream or multipart-upload CSV chunks to R2.

[P2] Search and sort across all submissions — `app/routes/forms.$formId.submissions/data-table.tsx:43`

Search and sorting operate only on the current 50-row cursor page. Users can receive “no results” while a match exists later, and ascending time order does not show the oldest records globally. Move filtering and ordering into loader query parameters and cursor SQL, or label them explicitly as page-only.

[P2] Allow disabling features after capability loss — `app/routes/forms.$formId.settings.notifications.tsx:98`

An enabled notification feature becomes checked-and-disabled when its queue disappears, while server validation rejects saving that enabled policy. The same recovery trap exists in `settings.uploads.tsx:70` and `settings.security.tsx:174,227`. Disable only the transition from off to on; always permit turning an existing feature off.

Overall: typecheck and all 19 tests pass. Material gaps remain around pre-auth secret mutation, revision conflicts, direct-upload extension enforcement, queued export UX, integration snippets, and paginated search. No files were edited.

