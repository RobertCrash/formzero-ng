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
- **Email notifications** — configure global SMTP credentials and per-form
recipients, reply-to fields, and subject templates.
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
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
provides per-form abuse controls.
- A daily Cron Trigger handles retention, expired uploads, and delivery
recovery.

The base form backend uses D1. R2, Queues, rate-limit bindings, and selected
secrets enable the corresponding features; the dashboard reports which
capabilities are configured.

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
- `BETTER_AUTH_BASE_URL` — local application URL; the default is
`http://localhost:5173`.
- `FORMZERO_ENCRYPTION_KEY` — exactly 32 bytes, encoded as 64 hexadecimal
characters or base64; encrypts SMTP, Turnstile, and webhook secrets.
- `FORMZERO_PUBLIC_URL` — public base URL used in generated links.
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
`IP_HASH_SECRET`. For `FORMZERO_ENCRYPTION_KEY`, use its
[Encryption Key Generator](https://jwtsecrets.com/tools/encryption-key-generator)
and select AES, 256 bits, and hexadecimal output.

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
deploys the Worker.

You will be prompted for the values declared in `.dev.vars.example`. Generate
unique values for `BETTER_AUTH_SECRET`, `FORMZERO_ENCRYPTION_KEY`, and
`IP_HASH_SECRET` with OpenSSL or the JWT Secrets alternatives described above.
Keep them unchanged when updating the deployment. Set `BETTER_AUTH_BASE_URL`
and `FORMZERO_PUBLIC_URL` to the deployment's public HTTPS origin.
`TURNSTILE_SECRET` is optional because a Turnstile key can be configured per
form later.

See Cloudflare's
[Deploy to Cloudflare documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
for details about automatic resource provisioning and repository creation.

### Manual deployment

To deploy without the button:

1. Authenticate Wrangler and create the resources named in `wrangler.jsonc`:
  ```bash
   npx wrangler login
   npx wrangler d1 create formzero
   npx wrangler r2 bucket create formzero-uploads
   npx wrangler queues create formzero-deliveries
   npx wrangler queues create formzero-deliveries-dlq
  ```
2. Replace the placeholder `database_id` in `wrangler.jsonc` with the ID
  returned by `wrangler d1 create`. If you choose different resource names,
   update their bindings in the same file.
3. Configure production values. Secrets can be added with
  `npx wrangler secret put <NAME>`:
  - Required: `BETTER_AUTH_SECRET`.
  - Recommended: `FORMZERO_ENCRYPTION_KEY` for encrypted credentials and
  signed webhooks, plus `IP_HASH_SECRET` for hashed-IP storage and rate
  limiting.
  - Set `FORMZERO_PUBLIC_URL` and `BETTER_AUTH_BASE_URL` to the deployed
  application URL.
  - Optional: `TURNSTILE_SECRET` as a global fallback. A Turnstile secret can
  instead be encrypted per form from the dashboard.
4. Build, apply remote D1 migrations, and deploy:
  ```bash
   npm run deploy
  ```

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
preserving the D1, R2, Queue, Worker names, and resource IDs written into the
generated repository by Cloudflare. The push triggers a production build; its
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
- `npm run deploy` — build, migrate the remote D1 database, and deploy the
Worker.



## Technology

- [Cloudflare Workers](https://developers.cloudflare.com/workers/), D1, R2, Queues, Rate Limiting, Cron Triggers, and Turnstile
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