---
name: Mandatory privacy secrets
overview: Make `FORMZERO_ENCRYPTION_KEY` and the renamed `FORMZERO_HASH_SECRET` required Worker secrets (like `BETTER_AUTH_SECRET`), remove deployment capability gates, and keep per-form IP storage (`ipMode`) as the operator's privacy choice—hashed IP retention stays optional.
todos:
  - id: env-types
    content: Make FORMZERO_ENCRYPTION_KEY and FORMZERO_HASH_SECRET required on AppEnv; remove IP_HASH_SECRET
    status: completed
  - id: capabilities
    content: Drop credentialEncryption/ipHashing capabilities and related validation/UI gates
    status: completed
  - id: hash-rename
    content: Rename createIpHmac → createKeyedHash; wire FORMZERO_HASH_SECRET in build-context and rate-limit errors
    status: completed
  - id: call-sites-docs
    content: Update remaining call sites, .dev.vars.example, README, package.json deploy bindings
    status: completed
  - id: tests
    content: Update tests for required secrets and removed optional-capability cases
    status: completed
isProject: false
---

# Mandatory encryption and hash secrets

## Intent

Today both secrets are optional *deployment* capability gates: missing `FORMZERO_ENCRYPTION_KEY` blocks SMTP/Turnstile form secrets/webhooks; missing `IP_HASH_SECRET` blocks rate limiting. Make the secrets **required** so those features are always *available*, and rename the hash secret to match its broader role.

**Do not** remove the per-form privacy choice for whether hashed IPs are *stored*. That remains `policy.privacy.ipMode` (`full` | `hashed` | `none`) in security settings.

| Layer | Mandatory? | What it controls |
|-------|------------|------------------|
| `FORMZERO_HASH_SECRET` (Worker secret) | Yes | Ability to compute keyed HMACs (rate-limit keys; optional storage) |
| `ipMode` (per form) | No — operator choice | Whether `source_ip` / `source_ip_hash` are **persisted** |

Existing persistence rules in [build-context.server.ts](app/lib/submissions/build-context.server.ts) stay:

- `sourceIp` stored only when `ipMode === "full"`
- `sourceIpHash` stored only when `ipMode !== "none"`
- `rateLimitIpHash` may still be computed in-memory for rate limiting even when `ipMode === "none"` (not a privacy-storage decision)

## Secret definitions ([app/lib/env.ts](app/lib/env.ts))

```ts
FORMZERO_ENCRYPTION_KEY: string  // was optional
FORMZERO_HASH_SECRET: string     // was IP_HASH_SECRET?: string
```

Update comments:

- **`FORMZERO_ENCRYPTION_KEY`** — required AES key (32 bytes hex/base64) for all stored credentials (SMTP passwords, per-form Turnstile secrets, webhook signing secrets).
- **`FORMZERO_HASH_SECRET`** — required instance-wide HMAC secret for keyed hashes of request/privacy metadata. **Today:** client IP for rate-limit keys and (when the form opts in via `ipMode`) `source_ip_hash` storage. **Not** auth credentials (Better Auth owns that). Named generically so future privacy hashes can reuse the same secret without another env var.

No dual-read of `IP_HASH_SECRET`. Existing deployments must set the new name (`wrangler secret put FORMZERO_HASH_SECRET`) and may delete the old secret.

## Capability model ([app/lib/form-config/capabilities.server.ts](app/lib/form-config/capabilities.server.ts))

Remove `credentialEncryption` and `ipHashing` from `Capabilities` — they are no longer configuration choices.

- `getCapabilities`: drop those booleans; `turnstile` becomes `turnstileAccountSecret || true` (form-owned secrets are always storable) → effectively always `true`. Keep `turnstileAccountSecret` for UI that distinguishes account vs form secret routes.
- `validatePolicyCapabilities`: remove the rate-limit / `IP_HASH_SECRET` error branch.
- `resolveCaptchaSecretSource`: drop the “encryption key not set” branch for form secrets; keep missing-credential and missing-account-secret checks.

## Call-site renames and assumptions

| Area | Change |
|------|--------|
| [build-context.server.ts](app/lib/submissions/build-context.server.ts) | Use `env.FORMZERO_HASH_SECRET`. Compute HMAC when a client IP is present (for `rateLimitIpHash` and optional storage). **Keep** `ipMode` gates on what is written to `core.sourceIp` / `core.sourceIpHash`. Rename `createIpHmac` → `createKeyedHash`. |
| [apply-rate-limit.server.ts](app/lib/submissions/apply-rate-limit.server.ts) | Error text names `FORMZERO_HASH_SECRET` only for missing IP (secret assumed present). |
| Local `CapabilityEnv` / `ContextEnv` / delivery env stubs | Require the two secrets or take `AppEnv` / `Pick<AppEnv, …>`. |
| Encrypt/decrypt/settings/webhooks/security/SMTP paths | Stop treating missing encryption key as a soft capability; keep **format** validation (exactly 32 bytes). Defensive 503s can stay as deployment-fault messages, or be simplified where types already guarantee presence. |

## UI cleanup

- [forms.$formId.settings.security.tsx](app/routes/forms.$formId.settings.security.tsx) — enable form-secret Turnstile and rate-limit profiles; remove “needs `FORMZERO_ENCRYPTION_KEY` / `IP_HASH_SECRET`” hints. **Leave** the IP storage select (`full` / `hashed` / `none`) unchanged.
- [settings-dialog.tsx](app/components/settings-dialog.tsx) / [settings.notifications.tsx](app/routes/settings.notifications.tsx) / [app-sidebar.tsx](app/components/app-sidebar.tsx) — remove `credentialEncryption` prop/state and the SMTP “key not set” warning branch.
- [forms.$formId.settings.tsx](app/routes/forms.$formId.settings.tsx) — drop “Credential encryption: Configured/Missing” status line.

## Docs and deploy metadata

- [.dev.vars.example](.dev.vars.example) — both secrets uncommented/required (same style as `BETTER_AUTH_SECRET`); document hash secret’s broader privacy-HMAC role; remove the rename TODO.
- [README.md](README.md) — mark both required; move them out of “optional post-deployment”; deploy section: set both after/with `BETTER_AUTH_SECRET`; note rename from `IP_HASH_SECRET` for upgraders.
- [package.json](package.json) `cloudflare.bindings` — mark `FORMZERO_ENCRYPTION_KEY` required (drop “Optional”); **add** `FORMZERO_HASH_SECRET` (it was never on the deploy button).

## Tests

Update fixtures and assertions that still use `IP_HASH_SECRET` or optional-key behavior:

- [captcha-secret.test.ts](app/lib/form-config/captcha-secret.test.ts) — remove “rejects rate limiting without IP_HASH_SECRET”; adjust turnstile/encryption capability expectations.
- [notification-settings-action.test.ts](app/routes/notification-settings-action.test.ts), [email.test.ts](app/lib/email/email.test.ts) — drop or rewrite “no encryption key” cases to match required env (or keep only format-invalid cases if useful).
- Any other tests passing partial env stubs get both secrets in fixtures.

## Out of scope

- No change to `ipMode` schema, defaults, or retention behavior — hashed IP **storage** stays optional per form.
- No new hashed fields beyond IP in this change (broader case is naming + docs + helper rename).
- No boot-time `checkPlatformBindings` extension for secrets (same model as `BETTER_AUTH_SECRET`: typed required, fails when features run without them).
- `TURNSTILE_SECRET` and `FORMZERO_PUBLIC_URL` stay optional.