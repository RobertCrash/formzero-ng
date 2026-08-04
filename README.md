# FormZero NG

A self-hosted, Cloudflare-native form backend for static sites and web apps.

FormZero NG receives HTML, JSON, and multipart submissions, then gives you an
authenticated dashboard for validation, spam protection, delivery, uploads,
analytics, exports, and retention. Your application and data stay in your own
Cloudflare account.

> FormZero NG is a next-generation fork of [FormZero](https://github.com/BohdanPetryshyn/formzero).
>
> See [Acknowledgements](#acknowledgements) for upstream attribution.

## Features

- **Flexible submission API** — accept HTML forms, JSON, URL-encoded data, and
multipart requests.
- **Policy-driven validation** — define typed fields, required values, size
limits, accepted content types, and unknown-field handling per form.
- **Security and spam controls** — origin allowlists, honeypots, minimum fill
times, Cloudflare Turnstile, and configurable rate-limit profiles.
- **Dashboard and analytics** — manage multiple forms, inspect submissions, and
view weekly, monthly, and 30-day trends.
- **CSV exports** — download smaller exports immediately and process larger
exports in the background.
- **Email notifications** — send through Cloudflare Email Service or your own
SMTP server, with per-form recipients, reply-to fields, and subject templates.
- **Signed webhooks** — deliver `submission.created` events over HTTPS with
HMAC signatures, retries, and delivery history.
- **File uploads** — support inline multipart uploads and direct upload
sessions backed by private Cloudflare R2 storage.
- **Privacy and retention** — choose full, hashed, or omitted IP storage and
configure automatic cleanup for IPs, submissions, and files.
- **Integration helpers** — generate policy-aware HTML and JavaScript examples
and expose a public form-configuration endpoint.



## Architecture

The application runs as one Cloudflare Worker with `fetch`, Queue consumer, and
scheduled handlers:

- [React Router 7](https://reactrouter.com/) provides the SSR application and
API routes.
- [Cloudflare D1](https://developers.cloudflare.com/d1/) stores users, forms,
policies, submissions, and delivery state.
- [Cloudflare R2](https://developers.cloudflare.com/r2/) stores private uploads
and large generated exports.
- [Cloudflare Queues](https://developers.cloudflare.com/queues/) processes
email, webhook, and export jobs.
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
delivers notification emails through the `send_email` binding.
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
provides per-form abuse controls.
- A daily Cron Trigger handles retention, expired uploads, and delivery
recovery.

### Resource bindings are a contract

Every binding declared in `wrangler.jsonc` is required at runtime, and every one
is available on the Workers Free plan. The Worker reads these names, and they
must match `wrangler.jsonc` exactly:

| Binding | `wrangler.jsonc` key | Feature |
| --- | --- | --- |
| `DB` | `d1_databases` | Users, forms, policies, submissions, delivery state |
| `UPLOADS` | `r2_buckets` | File uploads and generated exports |
| `DELIVERY_QUEUE` | `queues.producers` | Background email, webhook, and export jobs |
| `EMAIL` | `send_email` | Cloudflare email transport |
| `RATE_LIMIT_STRICT`, `RATE_LIMIT_STANDARD`, `RATE_LIMIT_RELAXED` | `ratelimits` | Per-form abuse controls |

Renaming a binding does not fail the build; it leaves the corresponding feature
silently unavailable. Form settings show a diagnostics panel naming any binding
that is missing or bound to the wrong resource type, and `npm run check:config`
asserts the contract in CI.

What genuinely remains optional is secrets, not bindings: the dashboard reports
which of those are configured.

## Local development



### Prerequisites

- Node.js and npm
- A Cloudflare account for remote deployment



### Setup

```bash
git clone https://github.com/RobertCrash/formzero-ng.git
cd formzero-ng
cp .dev.vars.example .dev.vars
npm install
npm run migrate
npm run dev
```

Before starting the app, fill in `.dev.vars`:

- `BETTER_AUTH_SECRET` — secret used by Better Auth.
- `FORMZERO_ENCRYPTION_KEY` — optional; exactly 32 bytes, encoded as 64
hexadecimal characters or base64. It encrypts the three kinds of credential
FormZero stores: custom SMTP passwords, per-form Turnstile secrets, and webhook
signing secrets. Each of those features is unavailable without it. Email over
the default Cloudflare transport stores no credentials, so it does not need the
key.
- `FORMZERO_PUBLIC_URL` — optional public base URL used for links in
notification emails.
- `TURNSTILE_SECRET` — optional global Cloudflare Turnstile secret.
- `IP_HASH_SECRET` — HMAC secret for hashed IP storage and IP-based rate
limiting.

Generate `BETTER_AUTH_SECRET`, `FORMZERO_ENCRYPTION_KEY`, and `IP_HASH_SECRET`
locally with:

```bash
openssl rand -hex 32
```

Alternatively, use [JWT Secrets](https://jwtsecrets.com/) to generate a
different 256-bit hexadecimal value for `BETTER_AUTH_SECRET` and
`IP_HASH_SECRET`.

Use a different generated value for each one. Obtain `TURNSTILE_SECRET` from
Cloudflare if you enable Turnstile. `.dev.vars` is ignored by Git.

The first account created becomes the instance administrator. FormZero NG is
currently intended for a single administrator rather than teams or public
sign-up.

## Cloudflare deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RobertCrash/formzero-ng)

The deployment flow clones this repository into your GitHub or GitLab account,
lets you choose the Worker and resource names, provisions the D1 database, R2
bucket, and Queues declared in `wrangler.jsonc`, applies the D1 migrations, and
deploys the Worker. Keep the binding names as they are; the resource names behind
them are yours to choose.

The initial deployment prompts only for `BETTER_AUTH_SECRET`. Better Auth
derives the application URL from incoming requests, so no public URL is needed
before the first deployment. Keep the generated authentication secret unchanged
when updating the deployment.

### Enable email sending

Notification emails default to Cloudflare Email Service, which needs a sending
domain onboarded once:

```bash
npx wrangler email sending enable <your-domain>
```

This publishes the SPF, DKIM, and DMARC records Cloudflare needs to sign and
authenticate outbound mail for that domain. Then open **Settings → Email
Notifications** in the dashboard and set the sender address to an address on that
domain. The Cloudflare transport rejects any other sender with
`E_SENDER_NOT_VERIFIED`.

Two [plan limits](https://developers.cloudflare.com/email-service/platform/pricing/)
are worth knowing before you point forms at third-party recipients:

- Sending to verified destination addresses in your own Cloudflare account is
free on every plan, including Workers Free. Notifications that go to the
operator's own mailbox stay on this path.
- Sending to arbitrary recipients requires Workers Paid, which includes 3,000
emails per month. On a free account, a form configured with third-party
recipients fails — the delivery log names the reason rather than showing a raw
error code.

To send through your own mail server instead, choose **Custom SMTP server** in
the same dialog. That path stores an encrypted password, so it also needs
`FORMZERO_ENCRYPTION_KEY`.

### When a delivery fails

A failing notification is retried with a growing delay for about two hours.
Failures that cannot be fixed by retrying — an unverified sender, an invalid
recipient — are marked failed immediately instead of consuming five attempts.

Deliveries that exhaust their retries land in the `formzero-deliveries-dlq` queue,
whose consumer marks the job as given up on. They appear under **Form settings →
Notifications → Delivery log** with the reason and a **Retry** button, and the
daily maintenance run logs how many are waiting, so an unnoticed backlog shows up
in Workers Logs.

### Optional post-deployment configuration

After Cloudflare assigns the Worker URL, configure these values only when the
corresponding features are needed:

```bash
# Encrypt stored credentials: custom SMTP passwords, per-form Turnstile
# secrets, and webhook signing secrets.
openssl rand -hex 32 | npx wrangler secret put FORMZERO_ENCRYPTION_KEY

# Use the deployed HTTPS origin for links in notification emails.
npx wrangler secret put FORMZERO_PUBLIC_URL
```

Enter the deployed origin without a trailing slash when prompted for
`FORMZERO_PUBLIC_URL`. `TURNSTILE_SECRET` remains optional because a Turnstile
key can be configured per form later. `IP_HASH_SECRET` is recommended for
hashed-IP storage and IP-based rate limiting.

See Cloudflare's
[Deploy to Cloudflare documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
for details about automatic resource provisioning and repository creation.

### Manual deployment

`wrangler.jsonc` declares every resource by name and deliberately commits no
resource IDs, so Wrangler
[provisions](https://developers.cloudflare.com/workers/wrangler/configuration/)
what is missing on the first deploy and keeps it linked afterwards. Do not create
the resources by hand: `wrangler d1 create formzero` derives the binding name
from the database name, offers to write a **second** `d1_databases` entry into
`wrangler.jsonc`, and the resulting `formzero` binding is not the `DB` the Worker
reads. If you must create resources manually, pass the binding name explicitly
(`--binding DB`) and decline Wrangler's offer to edit the configuration.

1. Authenticate Wrangler:
  ```bash
   npx wrangler login
  ```
2. Add the required authentication secret with
  `npx wrangler secret put BETTER_AUTH_SECRET`.
3. For the **first** deployment, provision and bind the resources, then apply
   migrations to the database that now exists:
  ```bash
   npm run deploy:init
  ```
   This briefly exposes the Worker against an unmigrated database, which is
   harmless on a fresh install with no users. For every later deployment use
   `npm run deploy`, which applies additive migrations before the new code goes
   live.
4. Wrangler writes the provisioned database ID back into your local
   `wrangler.jsonc`. Discard that change — the binding stays linked without it,
   and a committed ID would point every fork at your account. `npm run
   check:config` fails if one is committed.
5. Enable email sending as described in
  [Enable email sending](#enable-email-sending), and add any optional values from
  [Optional post-deployment configuration](#optional-post-deployment-configuration).

Review [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
for the current limits of your account. This project does not impose its own
form or submission quotas, but Cloudflare resource limits still apply.

### Updating a deployment

The **Deploy to Cloudflare** button is intended for creating a new installation,
not for updating an existing Worker. Running it again can create another
repository or new resources.

#### Deployment created with the button

The button creates a GitHub or GitLab repository connected to
[Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
Update that generated repository and push its production branch:

```bash
git remote add upstream https://github.com/RobertCrash/formzero-ng.git
git fetch upstream
git checkout main
git merge upstream/main
npm install
npm test
npm run typecheck
git push origin main
```

Add the `upstream` remote only once. Before pushing, resolve any conflicts by
preserving the D1, R2, Queue, and Worker names in the generated repository, and
keep the binding names unchanged. The push triggers a production build; its
deploy command applies migrations and deploys the updated Worker.

To redeploy the same commit without fetching an update, open the Worker in the
Cloudflare dashboard, select **Deployments** → **View build history**, open the
build menu, and select **Retry build**. Retrying a build does not pull newer
FormZero NG code.

#### Manually deployed installation

Back up production data, review new migrations and configuration changes, then
update and deploy the existing checkout:

```bash
git pull
npm install
npm test
npm run typecheck
npm run deploy
```

For either workflow, keep the existing D1 database, storage resources, Worker
name, and secrets to preserve forms, submissions, files, endpoint URLs, and
encrypted credentials. Changing authentication or encryption secrets can
invalidate sessions or make stored credentials unreadable.

## Submission endpoint

Each form exposes:

```text
POST https://<your-worker>/api/forms/<form-id>/submissions
```

The dashboard's **Integration** page generates HTML and JavaScript examples
that match the form's current field, security, CAPTCHA, and upload policy.

To send a basic test submission to a live deployment, replace the values below
and run:

```bash
FORMZERO_URL="https://your-worker.example.com"
FORMZERO_FORM_ID="replace-with-form-id"
FORM_ORIGIN="https://your-allowed-origin.example.com"

curl --fail-with-body --show-error \
  --request POST \
  --url "${FORMZERO_URL}/api/forms/${FORMZERO_FORM_ID}/submissions" \
  --header "Origin: ${FORM_ORIGIN}" \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --data '{"name":"Live test","email":"test@example.com","message":"Test submission from curl"}'
```

Replace the JSON keys with the form's configured field names. The origin must
be allowed by the form's security settings; omit the `Origin` header only when
the form permits requests without one. If Turnstile or honeypot timing is
enabled, use the generated example on the **Integration** page so the required
security fields and tokens are included.

## Commands

- `npm run dev` — start the local development server.
- `npm run migrate` — apply D1 migrations locally.
- `npm run migrate -- --remote` — apply D1 migrations remotely.
- `npm run build` — create a production build.
- `npm test` — run the Vitest suite.
- `npm run typecheck` — regenerate Cloudflare and route types, then run
TypeScript checks.
- `npm run check:config` — assert `wrangler.jsonc` declares exactly the expected
binding names and commits no `database_id`.
- `npm run check:advisories` — fail on any high or critical dependency advisory
that is not recorded in
[scripts/known-advisories.json](scripts/known-advisories.json), and on any
recorded one whose review date has passed. Each entry states why the advisory
does not affect the deployed Worker; entries are not a way to silence findings
permanently.
- `npm run deploy:init` — build, deploy, then migrate. Use once, for the first
deployment, when the database does not exist yet.
- `npm run deploy` — build, migrate the remote D1 database, and deploy the
Worker. Use for every later deployment.



## Technology

- [Cloudflare Workers](https://developers.cloudflare.com/workers/), D1, R2, Queues, Email Service, Rate Limiting, Cron Triggers, and Turnstile
- [React 19](https://react.dev/)
- [React Router 7](https://reactrouter.com/)
- [Better Auth](https://www.better-auth.com/)
- [Tailwind CSS 4](https://tailwindcss.com/) and [shadcn/ui](https://ui.shadcn.com/)
- [Vitest](https://vitest.dev/)



## Contributing

Issues and pull requests are welcome in
[RobertCrash/formzero-ng](https://github.com/RobertCrash/formzero-ng).

## Acknowledgements

FormZero NG was cloned from and remains based on
[Bohdan Petryshyn's FormZero](https://github.com/BohdanPetryshyn/formzero).
The upstream copyright notice is retained in [LICENSE](LICENSE).

## License

[MIT](LICENSE)