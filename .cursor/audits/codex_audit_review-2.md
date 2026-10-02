I reviewed `main` at **[`c2891bb`](https://github.com/RobertCrash/formzero-ng/commit/c2891bbc047c7a46d8f2871decee99cd84e9c25a), September 9, 2026**, including the three commits since the previous review.

**The implementation has improved substantially, but I would still hold production promotion.** Several earlier findings are addressed; others have fixes that introduce new failures or remain incomplete. The largest gap is between passing mocked tests and actual Workers/D1/R2 behavior.

Verification:

| Check                                | Result                                  |
| ------------------------------------ | --------------------------------------- |
| Clean dependency installation        | Passed                                  |
| Existing tests                       | **177 passed across 27 files**          |
| TypeScript                           | Passed                                  |
| Production build                     | Passed                                  |
| Binding configuration check          | Passed                                  |
| All 11 migrations in isolated SQLite | Passed                                  |
| Targeted Workers runtime checks      | Confirmed upload and CORS failures      |
| Latest GitHub CI                     | **Failed at dependency advisory check** |

The normal development server could not start in this review environment because network-interface enumeration was restricted. Targeted Miniflare checks worked. They used compatibility date `2026-07-29`, because the installed runtime rejected the repository’s configured `2026-08-04`. I did not deploy or modify repository source.

**1a) General assessment**

The codebase is becoming more coherent. The email rendering/transport separation, explicit capability checks, delivery snapshots, database-backed signup claim, and maintenance reporting are useful improvements.

Compared with the previous review:

* Webhook signing secrets are now returned and displayed after creation or rotation.
* Upload-session requests have a separate rate-limit scope.
* Email jobs snapshot recipients and rendering configuration.
* Date validation is stricter.
* Minimum-fill-time enforcement now rejects missing timestamps.
* CI, a Node version file, and dependency advisory review have been added.

However, several comments and tests describe guarantees the implementation does not actually provide. For example, the deletion test’s fake database accepts a write that the real schema rejects. The export test accepts arbitrary streams that R2 rejects.

There is also a concrete dashboard usability issue: the field editor uses `key={`${index}-${field.name}`}`. Editing a name changes its React key, remounting the row and potentially losing input focus on every keystroke. Use a stable editor-row identifier. [Field editor](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/routes/forms.$formId.settings.fields.tsx)

**1b) Architecture and functional correctness**

These are the findings I would prioritize.

1. **P1 — Both upload modes fail in the new streaming helper.**

   `limitAndHash()` calls:

   ```ts
   new DigestStream("SHA-256")
   ```

   In the local Workers runtime, this throws **`DigestStream is not defined`**. The supported constructor is `new crypto.DigestStream(...)`. Both inline and direct uploads use this helper. [Implementation](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/uploads/limited-stream.ts#L58), [Cloudflare API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

   There is a second failure underneath it: piping through ordinary `TransformStream`s loses the stream’s known length. R2 rejects that result with:

   > Provided readable stream must have a known length

   Fix both together: use the correct digest constructor, preserve/enforce the known upload size with `FixedLengthStream`, and handle cancellation and errors across the complete pipeline. Merely correcting the constructor will not restore uploads.

2. **P1 — Background CSV exports have the same R2 stream incompatibility.**

   `processExport()` passes an ordinary `TransformStream.readable` into `R2.put()`. Its unit test replaces R2 with a function that simply reads the stream, hiding the incompatibility. [Export implementation](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/delivery/process-export.server.ts)

   For large exports whose final size is unknown, use bounded R2 multipart uploads, including abort handling. For genuinely small exports, a bounded buffer is simpler.

3. **P1 — Direct uploads do not work across origins.**

   The file-upload and session-completion routes have no `OPTIONS` loader. Calling the **built application** through Miniflare returned **400 without CORS permission headers** for both preflights.

   Additionally, the shared CORS helper advertises only `POST, OPTIONS`, while uploading file bytes requires `PUT`. [File route](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/routes/api.forms.$formId.uploads.$sessionId.files.$fileId.tsx), [CORS helper](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/submissions/validate-origin.ts)

   This directly affects a Webflow frontend on `space-shack.com` submitting to a separately hosted FormZero backend. Add preflight handling to every upload endpoint and allow the appropriate method per route.

4. **P1 — The new CAPTCHA configuration cannot be saved through the UI.**

   The UI now includes `security.captcha.secretSource`, but `savePolicyRequest()` rejects **any property name containing `secret` or `password`**.

   Consequently, both account-secret and form-secret configurations are rejected with **422**. I reproduced this in the actual save function with authentication stubbed. [Save validation](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/form-config/settings.server.ts#L94)

   Replace the substring blacklist with explicit schema validation that permits reference/configuration fields while rejecting plaintext credentials.

5. **P1 — Background deletion fails for forms containing files.**

   The purge deletes R2 objects, then executes:

   ```sql
   UPDATE submission_files SET object_key = NULL ...
   ```

   But `submission_files.object_key` is **`NOT NULL`**. Running the actual purge function against the migrated SQLite schema reproduced the constraint failure. The objects can already be deleted while database cleanup remains stuck. [Purge](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/uploads/delete-form.server.ts#L103), [Schema](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/migrations/0005_submission_platform.sql)

   There is another deletion defect: the final completion check counts remaining submission files but **does not check remaining exports**. If the deadline expires during export cleanup, deleting the form can cascade away the metadata needed to find leftover export objects.

   Use an explicit, schema-compatible deletion state, and require both file and export cleanup to finish before deleting the form row.

6. **P1 — Stricter policy validation can break existing forms during upgrade.**

   `migrateFormPolicy()` still only parses schema version 1 against the current schema. It does not transform older policies.

   Previously accepted policies can now fail during loading—for example, inline uploads configured with the old 50 KB request limit, or patterns using syntax excluded by the new matcher. I reproduced the inline-policy rejection. Because settings also load through this parser, affected forms may become impossible to repair through the dashboard. [Policy loader/migration](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/form-config/migrate-config.ts)

   Add a real policy migration or a tolerant read-and-repair path. Stricter validation on new saves must not unexpectedly invalidate already stored configuration.

7. **P1 — Retention throughput is still capped at 100 expired submissions per day.**

   The new implementation isolates failures and records backlog, but calls the expired-submission and expired-file categories only once, with a batch limit of 100. The schedule remains daily. [Maintenance](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/retention/run-scheduled-maintenance.server.ts#L179)

   Therefore, 250 new expirations each day still produce a growing backlog. Earlier categories can also consume the shared deadline and repeatedly starve later ones.

   Process repeated bounded batches, schedule continuations, and rotate or otherwise guarantee service to each category. Backlog reporting makes the problem visible; it does not drain it.

8. **P1 — Rate limiting can be enabled without its required secret.**

   The settings UI allows rate limiting, while `validatePolicyCapabilities()` no longer rejects a missing `IP_HASH_SECRET`. Submission processing then throws because no client-IP hash can be produced.

   I verified that an enabled rate-limit policy passes capability validation with an empty environment. [Capability validation](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/form-config/capabilities.server.ts), [Runtime enforcement](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/submissions/apply-rate-limit.server.ts)

   Restore the save-time dependency check and explain the missing configuration in the UI.

The overall architecture remains appropriate: **a modular monolith with D1 transactions/outbox, R2 objects, and asynchronous delivery** is a good fit. I would retain it.

The next architectural improvements should focus on recoverability and platform contracts:

* Keep the real database schema and R2 behavior in integration tests.
* Treat D1/R2 operations as a recoverable multi-step process.
* Retain the snapshot approach, but document that webhook destinations and global email transport settings remain live configuration.
* Add recovery for interrupted initial signup: an exception or termination after claiming `instance_owner` can leave an empty installation permanently claimed. [Signup path](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/routes/api.auth.$.tsx)
* Keep public request bodies tightly bounded. Calling `.json()` or `.formData()` after a limiter still materializes the parsed body; it is not fully streaming parsing. The request schema still permits 100 MB.

**2) Local development, mocked services, and hybrid development**

**Yes—the Cloudflare tools you describe are the right approach here, and the repository already has the foundation.** `react-router dev` uses `@cloudflare/vite-plugin`, which runs Worker code through Miniflare/workerd with local bindings. [Vite configuration](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/vite.config.ts), [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/)

The missing distinction is between **local development** and **the current test runner**: Vitest explicitly uses `environment: "node"`. Installing `@cloudflare/vitest-pool-workers` does not activate Workers testing. [Test configuration](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/vitest.config.ts)

I recommend these development modes:

| Component              | Default local mode                | Integration tests                       | Optional hybrid mode                                 |
| ---------------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Worker and SSR         | Vite + workerd                    | Workers runtime                         | Continue running locally                             |
| D1                     | Persistent local database         | Fresh migrated database                 | Dedicated remote development database                |
| R2                     | Local bucket                      | Actual emulated R2 binding              | Dedicated remote development bucket                  |
| Queues                 | Local producer and consumer       | Exercise job state and retry handling   | Remote queue with a deliberately configured consumer |
| Cloudflare email       | Local capture/logging             | Controlled binding responses            | Real sending to test recipients                      |
| Turnstile and webhooks | Mock endpoints/test configuration | MSW success, failure, timeout cases     | Selected real test endpoints                         |
| SMTP                   | Mail capture server               | Transport fake or SMTP integration test | Dedicated test SMTP account                          |

Cloudflare supports per-binding remote connections for D1, R2, KV, Email, and Queues. Rate-limit bindings and Durable Objects support local simulation, but not direct remote-binding connections in the same way. FormZero currently does not need KV or Durable Objects. [Binding support matrix](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)

For the testing packages, current Cloudflare documentation recommends **`@cloudflare/vitest-plugin`**, with Vitest 4.1+, and **`@msw/cloudflare`** for outbound HTTP/WebSocket mocks. The repository’s Vitest version meets that minimum, but the plugin migration still needs to be implemented and verified. [Testing setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [Outbound mocking](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/)

Use MSW for Turnstile verification responses and webhook receivers. It does not replace D1/R2 emulation or SMTP protocol testing.

The highest-value integration scenarios are:

1. Create a form, save CAPTCHA/rate-limit settings, and submit successfully.
2. Run the complete cross-origin direct-upload flow, including preflights.
3. Upload real bytes into emulated R2 and verify size, checksum, and attachment.
4. Generate a background export into R2.
5. Delete forms containing files and exports, interrupt cleanup, then resume.
6. Upgrade representative old policies and database state.
7. Process more than 100 expirations and verify the backlog drains.
8. Exercise queue retries, duplicate delivery, and dead-letter recovery.

For hybrid development, keep related resources consistent. A **local D1 plus remote delivery queue** is especially problematic here: messages contain only a job ID, so a deployed consumer cannot retrieve a job that exists solely in the developer’s local database.

Also distinguish `remote: true` on selected bindings from `wrangler dev --remote`. Full remote execution has no Vite equivalent, and Queues does not support that Wrangler remote mode. [Queues development](https://developers.cloudflare.com/queues/configuration/local-development/)

Other workflow fixes:

* Align Wrangler/workerd with the configured compatibility date.
* Have CI read `.nvmrc`; it currently requests Node 24 generally while `.nvmrc` pins `24.15.0`.
* Document `npm ci` and `nvm use`.
* Make local migration/seed targets explicit and add reset/seed/maintenance commands.
* Expand `seed.sql` beyond historical submissions to cover policies, uploads, delivery failures, and retention.
* Repair `better-auth-generate`: its command currently starts with `@better-auth/cli@latest`, without a command runner. Pin the CLI and invoke its executable correctly.
* Keep local email captured by default; Cloudflare supports logging and saving simulated email locally. [Email development](https://developers.cloudflare.com/email-service/local-development/sending/)

**3) Deployment strategy and flow**

The separation between `deploy:init` and subsequent upgrades is clearer, and migration-before-code is reasonable for **backward-compatible** upgrades. However, the current pipeline does not establish production readiness.

The latest [CI run](https://github.com/RobertCrash/formzero-ng/actions/runs/34324750035) failed on unreviewed advisories in:

* `nanoid`: `GHSA-2v37-7h3g-55p8`
* `nodemailer`: `GHSA-2x7j-588g-ccc2`
* `sharp`: `GHSA-rgj7-g3m4-5g8c`

Its test, typecheck, and build steps were therefore skipped. Those advisories need dependency updates or documented applicability analysis; the log alone does not prove production exploitability.

More importantly, `npm run deploy` does not run the verification gates, and the repository does not establish that Cloudflare Workers Builds waits for GitHub CI. I could not inspect the deployed account’s build settings.

There are two concrete deployment-related defects:

* **Queue names are advertised as configurable, but DLQ dispatch is hardcoded** to `formzero-deliveries-dlq`. Renaming the queue can route dead letters through normal processing. Derive the name from environment configuration and validate the relationship. [Batch dispatch](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/app/lib/delivery/process-batch.server.ts)
* **The blanket ban on `database_id` conflicts with deployment-specific configuration.** Keeping IDs out of the upstream template is sensible, but Cloudflare explicitly updates provisioned configuration with resource IDs. Validate templates and deployed installations differently. [Configuration check](https://github.com/RobertCrash/formzero-ng/blob/c2891bb/scripts/check-wrangler-config.ts), [Deploy-button provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

I would use this promotion flow:

1. Verify the exact commit: clean install, advisory review, unit tests, Workers integration tests, typecheck, build.
2. Deploy to isolated staging resources and apply migrations.
3. Run browser/API smoke tests, including uploads and background jobs.
4. Record a database recovery point and verify upgrade compatibility.
5. Apply compatible production migrations and promote the verified version.
6. Check submissions, delivery failures, cleanup backlog, and storage errors.
7. Perform incompatible cleanup migrations in a later release.

For this single-Worker application, explicit promotion after staging is sufficient initially. Tagged releases, documented recovery, and a passing integration suite matter more immediately than elaborate gradual rollout machinery.

**My recommended next milestone is a release focused on correcting these failures and adding Workers integration tests.** That would turn the existing architectural improvements into a reliably deployable implementation.
