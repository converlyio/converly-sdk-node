# @converly/sdk-node

Server-side conversion tracking for Node backends. Tell
[Converly](https://converly.io) the moment your code confirms a conversion (a
SaaS signup, a lead from a custom-coded form, a booking) and Converly fires it
to your connected ad platforms server-side, with the click IDs and identity
data that produce high match rates.

## What is Converly?

[Converly](https://converly.io) is a conversion tracking tool for
lead-generation and SaaS businesses. It sends conversions to Google Ads, Meta
Ads (Facebook and Instagram), Google Analytics 4, LinkedIn Ads, Microsoft
Ads, TikTok and more whenever someone converts on your website.

Browser-based tracking is unreliable. Safari and iOS restrict cookies, and ad
blockers stop the Google Tag or Meta Pixel from loading at all. Converly's
snippet captures the high-value signals in the browser (the Google click ID,
Meta's browser cookies, IP address, user agent), pairs them with the moment
your backend confirms the conversion, and delivers the event through each ad
platform's server-side API (Google Enhanced Conversions, Meta Conversions
API). The result is conversion tracking that ad blockers cannot see, with the
identity data that lifts match quality from "ignored" to "rewarded".

## When to use this package

Use `@converly/sdk-node` when **your own server code knows the moment a
conversion happens**. For example:

- A **SaaS signup**. Your backend creates the account.
- A **custom-coded form** on a Next.js, Astro, SvelteKit, Remix, or Express
  site. Your route handler or server action receives the lead.
- A **booking, quote request, or application** processed by your API.

Two prerequisites, both from your [Converly dashboard](https://converly.io):
the Converly snippet installed on your marketing site, and a flow using the
API trigger (the dashboard hands you the three values `createClient` needs).
Full setup guide: [Connect your app via the
API](https://help.converly.io/setup-triggers/connect-api).

If your forms are built with a supported form platform instead (Webflow,
Gravity Forms, Typeform, Jotform, and more), you do not need this package.
Converly detects those submissions automatically with no code.

> **Note for integrators (human or AI).** The main method is named
> `completeSignup` for historical reasons, but it reports **any conversion
> your backend confirms**. For a lead form, use it exactly the same way with
> a `customer_event_id` like `` `lead_${submission.id}` ``.

## How it works

When a visitor shows conversion intent on your site (submits your form,
clicks sign up), the Converly loader writes a short-lived
`cnv_signup_correlation` cookie holding a random correlation token, and
captures the browser-side signals against it. When your backend confirms the
conversion, you read that cookie with `readCorrelation` and call
`completeSignup(...)`. The SDK signs the request (HMAC-SHA256 over the exact
bytes on the wire) and POSTs it to Converly, which pairs the two halves and
fires the conversion at full match quality. Click IDs and browser signals
from the browser half, hashed identity from yours.

- **TypeScript-first.** The types are the documentation. The result is a
  discriminated union you can `switch` on, and a null token without an
  explicit opt-in is a compile error, not a runtime surprise.
- **Zero runtime dependencies.** Node 18+ (global `fetch`, `node:crypto`).
- **Dual ESM + CJS build.**
- **Never crashes your conversion flow.** `completeSignup` returns a promise
  you catch. A Converly outage degrades to "conversion not fired", never a
  thrown error into your handler.

## Install

```sh
npm install @converly/sdk-node
```

Node 18+ (for global `fetch`). On older Node, pass a `fetch` implementation via
`createClient({ fetch })`.

## Mark the conversion surface in the browser (don't skip this)

The correlation cookie only exists if the page captured conversion intent.
Add the data attribute to your form so the Converly loader snapshots the
browser signals at submit time:

```html
<form data-converly-signup-intent>...</form>
```

Or, from your own JavaScript (SPA route change, SSO button click):

```js
window.__converly.captureSaasSignupIntent();
```

Without this, `readCorrelation` returns null for every visitor and your
conversions fire at degraded match quality or not at all.

## Quickstart (Express)

Copy-paste runnable. Set the three env vars from your Converly dashboard.

```js
import express from 'express';
import { createClient } from '@converly/sdk-node';

const app = express();
app.use(express.json());

const converly = createClient({
  siteKey: process.env.CONVERLY_SITE_KEY,          // public site id
  triggerKey: process.env.CONVERLY_TRIGGER_KEY,     // e.g. 'main-signup'
  webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET, // secret, ≥32 chars
});

app.post('/signup', async (req, res) => {
  // 1. Read the correlation cookie the loader set (null if the visitor
  //    never went through Converly's marketing site).
  const token = converly.readCorrelation(req);

  // 2. Create the account (your code).
  const user = await createUser(req.body);

  // 3. Only fire for genuinely NEW accounts.
  if (user.created) {
    converly
      .completeSignup({
        correlation_token: token,
        customer_event_id: `account_created_${user.id}`, // stable, dedup key
        email: user.email,           // send it raw, Converly hashes it server-side
        allow_uncorrelated: false,   // no-op if token is null (see below)
      })
      // Always catch. A Converly failure must never break signup.
      .catch((err) => console.warn('[converly]', err.code, err.message));
  }

  res.redirect('/dashboard');
});

app.listen(3000);
```

> **Reading the cookie in other frameworks.** `readCorrelation` also accepts a
> raw `Cookie` header string, a Web `Request`/`Headers` object (Next.js Route
> Handlers, Remix), and framework cookie accessors such as `cookies.get(name)`
> (SvelteKit, Next.js `cookies()`):
>
> ```js
> // Next.js Route Handler / Remix
> const token = converly.readCorrelation(request); // reads request.headers.get('cookie')
> // SvelteKit action
> const token = converly.readCorrelation(event);
> ```

## Recipe: a custom-coded lead form (Next.js)

The same integration tracks any custom-built form whose submissions land in
your server code. Mark the form, then report the lead from the handler that
processes it:

```jsx
// The form component. The data attribute is the only browser-side change.
<form action={submitLead} data-converly-signup-intent>
  <input name="email" type="email" required />
  <button>Get a quote</button>
</form>
```

```js
// app/actions.js (a Next.js server action)
'use server';
import { cookies } from 'next/headers';
import { createClient } from '@converly/sdk-node';

const converly = createClient({
  siteKey: process.env.CONVERLY_SITE_KEY,
  triggerKey: process.env.CONVERLY_TRIGGER_KEY,
  webhookSecret: process.env.CONVERLY_WEBHOOK_SECRET,
});

export async function submitLead(formData) {
  const lead = await saveLead(formData); // your code: CRM, database, email

  converly
    .completeSignup({
      correlation_token: converly.readCorrelation({ cookies: await cookies() }),
      customer_event_id: `lead_${lead.id}`, // stable id = safe retries
      email: lead.email,
      allow_uncorrelated: false, // no-op for visitors who never hit your ads
    })
    .catch((err) => console.warn('[converly]', err.code));
}
```

That's the whole integration. One attribute in the browser, one call on the
server, and the lead reaches Google Ads and Meta with full match quality.

## Handling the result

`completeSignup` resolves to a discriminated union keyed on `status`. Switch on
it for exhaustive, type-checked handling:

```ts
const result = await converly.completeSignup({ /* … */ });

switch (result.status) {
  case 'promoted':               // accepted & queued, full match quality
  case 'promoted_uncorrelated':  // accepted & queued, degraded quality (allow_uncorrelated)
    console.log(`queued ${result.promoted_count} conversion(s)`);
    break;
  case 'awaiting_browser_half':  // webhook beat the browser signal; fires when it lands
    break;
  case 'no_matching_flows':      // no Converly flow points at this trigger yet
  case 'no_promotion':           // correlated but nothing to promote
    break;
  case 'skipped_uncorrelated':   // unusable token + allow_uncorrelated:false, so no request sent
    break;
  case 'unknown':                // server returned a newer status, so upgrade the SDK
    break;
}
```

| `status`                 | Queued? | Extra fields                       |
| ------------------------ | ------ | ---------------------------------- |
| `promoted`               | ✅     | `promoted_count`, `customer_event_id` |
| `promoted_uncorrelated`  | ✅ (degraded) | `promoted_count`, `customer_event_id` |
| `awaiting_browser_half`  | not yet | `promoted_count: 0`, `customer_event_id` |
| `no_matching_flows`      | ❌     | `customer_event_id`                |
| `no_promotion`           | ❌     | `promoted_count: 0`, `customer_event_id` |
| `skipped_uncorrelated`   | ❌ (no request) | `fired: false`, `reason`, `customer_event_id` |
| `unknown`                | ?      | `raw` (parsed body), `customer_event_id` |

`promoted` / `promoted_uncorrelated` mean Converly **accepted and queued** the
conversion (one events row per matched flow). Delivery to Google/Meta happens
asynchronously moments later, with Converly's own retries behind it. Check the
debug log in your dashboard for per-platform delivery status.

`awaiting_browser_half` means your webhook arrived before the browser signal.
If the browser half lands within the ~5-minute merge window the conversion
fires with full attribution; otherwise Converly still fires it at the window's
expiry using the PII you sent (degraded match quality, but late beats never).

## Uncorrelated signups

A **null** `correlation_token` means the visitor never went through the Converly
loader (admin-created account, backfill, SSO-only user). By default that is a
**no-op** and no request is sent, because firing a conversion for someone who
didn't actually convert wastes ad budget.

The type system makes you decide. When the token might be null (e.g. straight
from `readCorrelation`), `allow_uncorrelated` is **required**:

```ts
const token = converly.readCorrelation(req); // string | null

// No-op on null (the common, safe choice):
await converly.completeSignup({ correlation_token: token, customer_event_id, allow_uncorrelated: false });

// Fire anyway at degraded match quality:
await converly.completeSignup({ correlation_token: token, customer_event_id, allow_uncorrelated: true });
```

With a definitely-non-null token, `allow_uncorrelated` is irrelevant and can be
omitted.

> **Corrupted tokens.** A non-empty token that isn't a loader-issued shape
> (16 to 64 hex chars) is treated as "no token". With `allow_uncorrelated: false`
> the call skips with `reason: 'invalid_correlation_token'` (worth logging,
> because it usually means the wrong value is being passed), and with
> `allow_uncorrelated: true` it fires uncorrelated. Either way the SDK never
> sends a token the server would reject.

## Field hygiene

- **Blank strings are treated as omitted.** `email: ''` (the classic empty DB
  column) is normalized to `null` on the wire instead of being rejected
  server-side. Values are trimmed.
- **Unambiguously-invalid emails are rejected locally** with
  `ConverlyValidationError` before any request, so the mistake surfaces in
  your logs instead of silently losing the conversion to a server 400. The
  check is deliberately loose; any plausible email passes.
- **PII is sent raw** (never pre-hash). Converly normalizes and hashes it
  per platform, server-side.

## Retries & timeouts

- **5xx, 429 (rate limit), and network/timeout errors** retry 3 times with
  **1s, 3s, 9s** backoff (4 attempts total). Retrying is always safe,
  because Converly dedupes on `customer_event_id`.
- **Other 4xx errors** fail fast. A 4xx is a configuration or payload problem,
  not a transient one.
- The timeout is **per attempt** (default 5000 ms), not a total budget. It
  covers the **entire** attempt including reading the response body, so a
  stalled response can never hang your signup handler.
- **Every retry is signed fresh**, so a slow retry sequence can't drift
  outside the server's 5-minute signature-freshness window.

On persistent failure `completeSignup` rejects with a typed error (below), so
`.catch()` it and move on.

## Errors

Every error is a named class extending `ConverlyError`, with a stable, greppable
`code` and a `docsUrl`.

| Class                     | `code`                    | When |
| ------------------------- | ------------------------- | ---- |
| `ConverlyConfigError`     | `CONVERLY_CONFIG_INVALID` | Bad `createClient` options (thrown synchronously). |
| `ConverlyValidationError` | `CONVERLY_PAYLOAD_INVALID`| Bad `completeSignup` payload (thrown before any request). |
| `ConverlyAuthError`       | `CONVERLY_UNAUTHORIZED`   | 401. Signature rejected (the message explains the 3 causes). |
| `ConverlyRequestError`    | `CONVERLY_BAD_REQUEST`    | Other 4xx (e.g. 404 unknown site). No retry. |
| `ConverlyServerError`     | `CONVERLY_SERVER_ERROR`   | 5xx or 429 on every attempt. |
| `ConverlyNetworkError`    | `CONVERLY_NETWORK_ERROR`  | Network error / timeout on every attempt. |

```ts
import { ConverlyError, ConverlyAuthError } from '@converly/sdk-node';

try {
  await converly.completeSignup({ /* … */ });
} catch (err) {
  if (err instanceof ConverlyAuthError) {
    // A 401 means the wrong secret for the environment, clock skew > 5 min, or
    // a proxy re-serialized the body after signing. See err.message / err.docsUrl.
  } else if (err instanceof ConverlyError) {
    console.warn(`[${err.code}] ${err.message} (${err.docsUrl})`);
  }
}
```

## How the signature is computed

Stripe-style HMAC. The signature is computed over the **exact bytes sent on the
wire**. The SDK serializes the body once, signs that string, and sends that
same string. Never re-serialize or run a body-mutating middleware after signing,
or the signature breaks (a top cause of 401s).

```
X-Converly-Signature: t=<unix_ts>,v1=<hmac_hex>
```

Signing string:

```
<unix_ts>.POST.<url_path>.<raw_body>
```

- `url_path` is the full path, with a leading slash, no query string and no
  trailing-slash normalization.
- HMAC-SHA256 with your `webhookSecret`, hex, lowercase.
- 5-minute freshness window (keep the server clock NTP-synced).
- The header format is rotation-tolerant: additional `v1=` values are accepted
  during a key cutover.

## `createClient` options

| option          | required | default                      | description |
| --------------- | -------- | ---------------------------- | ----------- |
| `siteKey`       | yes      | none                         | Public site id (matches the loader's `?key=`). |
| `triggerKey`    | yes      | none                         | Signup trigger id, URL-safe ASCII, 1 to 64 chars. |
| `webhookSecret` | yes      | none                         | HMAC secret, ≥32 chars. Server-side only; environment-specific. |
| `apiBase`       | no       | `https://api.converly.io`    | Converly API base URL. |
| `fetch`         | no       | global `fetch`               | Custom fetch (Node <18, undici, tests). |
| `timeoutMs`     | no       | `5000`                       | Per-attempt timeout. |
| `userAgent`     | no       | `@converly/sdk-node/<version>` | Override the `User-Agent`. |

## License

[MIT](./LICENSE)
