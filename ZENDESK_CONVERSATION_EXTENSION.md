# Product Finder as a Zendesk Conversation Extension

The Product Finder can be opened from a Zendesk AI agent (web view action). When the
customer confirms the identified product, the app saves its name in the metadata of
**that same conversation** and posts a confirmation message on the customer's behalf,
so the AI agent can read the product and continue the flow.

```
Zendesk chat ──opens──▶ Product Finder (iframe, Webview SDK)
                              │ 1. WebviewSdk.getContext  → signed JWT
                              ▼
                  POST /api/zendesk/context          (early check, optional UX)
                  POST /api/zendesk/confirm-product  { token, productName, submissionId }
                              │ verify JWT (RS256 + exp, JWKS of ZENDESK_SUBDOMAIN, appId)
                              │ validate productName against src/data/productData.js
                              │ GET/PATCH conversation metadata (merge, keep existing keys)
                              │ POST message as the verified user
                              ▼
                  { ok: true }  →  WebviewSdk.close()
```

## Environment variables (server side only)

Set them in Vercel → Project → Settings → Environment Variables (Production + Preview), then redeploy.
They are read only by the functions in `api/`; none are exposed to the browser bundle.

| Name | Required | Description |
| --- | --- | --- |
| `ZENDESK_SUBDOMAIN` | yes | `acme` for `acme.zendesk.com`. Tokens from any other subdomain are rejected. |
| `SUNCO_APP_ID` | yes | Sunshine Conversations app id. Tokens for any other app are rejected. |
| `SUNCO_KEY_ID` | yes | Conversations API key id (Basic-auth user). |
| `SUNCO_SECRET` | yes | Conversations API key secret (Basic-auth password). |
| `ZENDESK_ALLOWED_INTEGRATION_IDS` | no | Comma-separated integration ids; if set, only tokens for these integrations are accepted. |

Create the key in Admin Center → Apps and integrations → APIs → Conversations API
(that page also shows the app id). See `.env.example`.

## URL for the AI agent web view action

```
https://find-product-omega.vercel.app/
```

No query string is needed (and no conversation id should be passed): the conversation and
user are taken from the signed token that the Webview SDK provides. Suggested size: **tall**.

## Saved conversation metadata

Example (existing keys are preserved; `lang` is just an illustration of a pre-existing key):

```json
{
  "lang": "en-us",
  "identified_product_name": "Sonnette® Roller Shades",
  "product_identification_status": "completed",
  "product_identification_source": "product_finder",
  "product_identification_submission_id": "21b5b089-1794-4f7b-bfb9-ae088d8b319d"
}
```

The first three keys are the integration contract (custom keys, not native Zendesk fields).
`product_identification_submission_id` is an internal idempotency marker (used to ignore
retries of a confirmation that was already delivered); the AI agent can ignore it.

The confirmation message posted to the conversation, authored by the customer:

> I have identified my product: Sonnette® Roller Shades.

## Reading the product in the AI agent

In the flow that contains the web view:

1. **Web view action**: URL above. Add a step that waits for the customer's next message —
   the confirmation message posted by the app arrives as a normal customer message and
   resumes the flow.
2. Add **Clear cached conversation**. The AI agent caches conversation data; without this
   step, *Get conversation* can return the metadata from before the customer confirmed.
3. Add **Get conversation** (the Sunshine Conversations "get conversation" call).
4. In the step's response mapping, map the metadata value to a flow parameter, e.g.
   - source: `conversation.metadata.identified_product_name`  (in the response JSON)
   - parameter: `identified_product_name` (text)
   Optionally also map `conversation.metadata.product_identification_status` to check it equals `completed`.
5. Use `{{identified_product_name}}` (or your parameter name) in later steps, conditions, and API calls.

> The exact labels/paths in the flow builder depend on your Zendesk version; the response
> of "get conversation" is `{ "conversation": { "id": …, "metadata": { … } } }`, so the value
> lives under `metadata.identified_product_name`.

## Behaviour

- Outside Zendesk (regular browser tab): the finder works as before; no confirm button, nothing is sent.
- Inside Zendesk but no valid context (Facebook Messenger, old mobile apps, expired/invalid session): a clear
  message is shown; the result is never reported as sent.
- Submission fails (network, Zendesk error): the product stays on screen, an error is shown and the customer can retry.
- A fresh `getContext` token is requested on every attempt (tokens are short lived).
- Duplicate protection: the button locks while sending; each result has a `submissionId`, reused for retries; the
  server ignores a `submissionId` that was already delivered, and de-duplicates concurrent requests.
- The page sends `Content-Security-Policy: frame-ancestors *` (see `vercel.json`) and no `X-Frame-Options`, so it can
  be embedded in the Web Widget on any host site. Nothing in the page uses cookies/local storage.
- The browser never sends a conversation id or user id; both come only from the verified token.

## Running the tests

```
npm run test:api     # token verification, metadata merge, idempotency, handlers (node:test)
```

Local UI development: `npm start` serves the UI only. To exercise `/api` locally use `vercel dev` with the
variables above.

## Manual end-to-end test in Zendesk (checklist)

1. Deploy, set the four environment variables, redeploy.
2. In the AI agent, add the web view action with the URL above and the flow steps described above, publish.
3. Open the Web Widget on your site, start a conversation, trigger the web view.
4. Answer the questions until *Sonnette® Roller Shades* (Up and Down → Fabric → Roller Shades → Sonnette Fabric).
5. Click **Confirm product and return to chat**. The web view closes and the message
   "I have identified my product: Sonnette® Roller Shades." appears as the customer's message.
6. Confirm the AI agent continues and that the mapped parameter equals `Sonnette® Roller Shades`.
7. Optional: `GET https://{subdomain}.zendesk.com/sc/v2/apps/{appId}/conversations/{conversationId}` with the
   API key shows the metadata above.
