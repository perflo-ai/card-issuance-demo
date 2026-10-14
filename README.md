# Tiny: a demo partner for the Perflo Partner API v2

A small app that plays **Tiny**, a partner whose chat assistant buys things for its users, integrating
Perflo's Partner API v2 the way a real partner would. Use it to demo the flow and to test the Perflo
backends end to end. Local only: this repository has no remote.

- **Tiny's server** (`server/`, Express + TypeScript) holds the partner id and secret, signs every Perflo
  request, and keeps each user's access token. The secret and the tokens never reach the browser or the
  logs. Full card details reach the browser only when the person presses "Show card details" on an open
  card: each press reads them fresh through a new single-use reveal link, the answer is `no-store`, and
  they are never stored or logged.
- **Tiny's web app** (`web/`, Vite + React) is a chat in the spirit of the partner's screens 1 to 9. Perflo
  appears only inside its own frames, embedded in the chat.
- **A mock Perflo** (`server/mock/`) for `DEMO_MODE=mock`, so the demo runs before the real backends are
  up. It verifies signatures exactly like the backend and follows SPEC sections 3, 4, 8 and 8a.

## Setup

Node 20 or newer.

```sh
npm install
npm run cert                 # self-signed certificate for https://localhost (openssl)
cp .env.example .env         # then fill in PARTNER_ID and PARTNER_SECRET (commands are in the file)
npm run dev                  # https://localhost:5174
```

The demo must be served at exactly `https://localhost:5174`: that is the origin Perflo's dev seed allows to
embed frames, and Perflo accepts only https origins. The port is fixed and the server refuses to start if it
is taken.

The certificate is self-signed, so the browser warns once per port. Open https://localhost:5174 and, in mock
mode, https://localhost:8791 once, and accept the warning on each. If you have
[mkcert](https://github.com/FiloSottile/mkcert), you can use a trusted certificate instead:
`mkcert -install && mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1`.
The server reads `certs/localhost.pem` and `certs/localhost-key.pem` either way, and trusts that certificate
for its own calls to the mock (`NODE_EXTRA_CA_CERTS` in the npm scripts).

## Mock mode (no Perflo backends needed)

```
DEMO_MODE=mock
PERFLO_API_BASE=https://localhost:8791
PARTNER_ID=<any v4 uuid>
PARTNER_KEY_VERSION=v1
PARTNER_SECRET=<any 43 base64url characters>
```

`npm run dev` starts the test payments service on `PERFLO_API_BASE` as well. Like Perflo, it sends Tiny a
signed webhook for every order and person status change (to `https://localhost:5174/webhooks/perflo`), with a
webhook secret made fresh for each run, so `PERFLO_WEBHOOK_SECRET` can stay unset here. Its state is in
memory, so a restart starts it fresh (the demo's own store in `data/` is kept: sign out and set up payments again after a
restart).

Things to try, in order:

1. Open the demo. Tiny asks for nothing about you: you land in the chat.
2. `buy me $50 worth of headphones on amazon`, then confirm. The first order asks you to **Set up payments**,
   right there in the chat: the frame asks for your email and the code (test code **123456**), then for your
   limits.
3. Your balance is empty, so the order asks you to add money. Pay in the frame (test payment, no card).
4. The one-time card is created and Tiny checks out. You see only the last 4 digits, the expiry and the card
   limit; the card is spent at the mock shop and the order shows as paid.
5. `book the 150.00 hotel on united.com`: orders above $100 show "Getting your card ready" first.
6. Once your orders pass $200 in total, an identity check is asked for: open it, finish it, then "try again".
7. `buy me $2600 worth of chairs on amazon` is declined in plain words, and so is anything above your per-order limit.
8. Test controls in the side panel:
   - **Stop at the checkout page**: the card stays open, so you can **Cancel card** and see the money return.
   - **Turn off Tiny's access**: your next order asks you to sign in again, then continues by itself.
9. **Add money** and **Change limits** in the side panel open Perflo's frames directly.
10. Card reuse: restart with `MOCK_REUSE_CARDS=true` and the mock answers like a partner in reuse mode. Every
    order within a card's 12 hours comes back on the same card (no second card fee). A charge may use the money
    of every open order on the card and pays the oldest open order first, so with **Stop at the checkout page**
    on for the first order, the next checkout shows as paid on that first order. Paying leaves the money on the
    card, cancelling one order leaves the card open for the others, and the card closes at its 12 hours,
    returning what is left. Every order answer says which mode it was placed under (`one_time`), so the
    card is "Card" from the first order on, not "One-time card"; later orders say "Same card as your last
    order", the Payments panel shows the card once (grouped by its `card_id`) with what its open orders are
    for together, and each order's cancel button says **Cancel order**. Against a Perflo that does not send
    `one_time` or the open cards' `card_id` yet, Tiny falls back to reading the cards it was given: the first
    order on a card shows "One-time card" until a second one lands on it.

Each order in the chat lists its steps (identity check and adding money only when the order asked for them)
and says what Tiny is doing or waiting for right now, from the statuses payments returned.

The developer log at the bottom of the panel shows every call Tiny's server made, every webhook it received
(tagged `webhook`) and every frame event, with access tokens, card details and link codes removed. It reads new
lines after each request the page makes and when the server says it wrote some, never on a timer.

Mock rules (illustrative numbers from the SPEC, not production values): card load = max($15, order x 1.033 +
$0.25), card fee $1; orders above $100 issue after about 3 seconds; identity check above $200 of total card
spending; cards up to $2,500; partner cap $10,000 per rolling 24 hours; cards expire after 12 hours.

## Live mode (a real Perflo backend)

```
DEMO_MODE=live
PERFLO_API_BASE=<the Perflo API base>
PARTNER_ID=<partner_id>
PARTNER_KEY_VERSION=<key_version>
PARTNER_SECRET=<secret>
PERFLO_WEBHOOK_SECRET=<whsec_... from Builder>
```

1. Have a Builder agent (the partner row) and create its credentials with
   `POST /v1/agents/:agent_id/partner-credentials`. The secret is shown once; put it in `.env`.
2. Allow the demo to embed frames: `PUT /v1/agents/:agent_id/allowed-origins` with
   `{"allowed_origins":["https://localhost:5174"]}` (the dev seed already registers this origin).
3. **Webhooks** (required: Tiny does not poll, so without them nothing moves after an order is placed). In
   Perflo Builder, on the agent, save the webhook address `https://<where Tiny runs>/webhooks/perflo`. Builder
   then shows the webhook secret (`whsec_...`, its own secret, not the partner API secret): put it in
   `PERFLO_WEBHOOK_SECRET`. Perflo calls that address from the internet, so on this computer it needs a public
   https address forwarded to `https://localhost:5174` (a tunnel); a hosted demo just uses its own address.
   Builder's **Send a test** sends a `ping`: the developer log shows "Test event from Perflo received".
4. Point `PERFLO_API_BASE` at the backend:
   - a local `perflo-backend-api` with `PARTNER_V2_ENABLED=true`: `http://localhost:3001`. Its `.env` points
     at production, so run it only with a development or staging configuration.
   - a staging or develop host that serves the partner API at its current address (`/v1/users`,
     `/v1/checkout/orders` and so on). Check it answers there before pointing the demo at it. Never point a
     local demo at production.
5. `npm run dev`.

**Rotating the webhook secret.** After you rotate it in Builder, Perflo signs every try with the new secret
only, retries included. Put the new one in `PERFLO_WEBHOOK_SECRET` and restart. Webhooks refused in between
are not lost: Perflo keeps trying each one for 24 hours, and Tiny recognises any it already handled.

In live mode Tiny never buys anything: there is no real shop. After the card details are read, it fills a
checkout form in memory and stops, and says so in the chat. The card stays open until you cancel it or it
expires after 12 hours, and unused money goes back to the balance either way. A live order still moves
real money from the balance onto the card, so use test accounts.

The right panel has two tabs. **Payments** is the balance, limits and money controls. **Orders** lists every
order sent to payments, newest first, with its status, what was paid or returned, and for an open card the
card itself (number and security code hidden until "Show card details") and a Cancel card button.

Frames from an `http://localhost` backend embedded in the https demo page are mixed content. Chrome and
Firefox treat `localhost` as trustworthy; Safari may block them. This was not verified in a browser.

## Customizing how Perflo looks: embedded pages and UI elements (live mode)

The header switches between two ways of showing Perflo inside Tiny. Both load Perflo.js from
`<PERFLO_API_BASE>/v1/perflo.js` and open Perflo with the `client_secret` Perflo returns beside each page link.

**Needs a Perflo with Checkout customization.** The API the demo points at must run perflo-backend-api #368, #369,
#370 and #371 (the brand on every page, `appearance` on the API, the payment form on Stripe's elements, Perflo.js and
the UI elements). The payment element also needs ms-fiat-payments #191 (the card checkout opened as Checkout elements).
Do not deploy this version of the demo before those are deployed to the API it points at. Against a Perflo without
them, Perflo.js does not load and pages that came with no `client_secret` open from their link as before.

- **Embedded pages** (the chat). The flow above, unchanged, with every Perflo page opened through
  `perflo.embeddedPage({ clientSecret }).mount(...)`: the sign-in page in the chat, the add money page on an order, and
  Add money and Change limits in the Payments panel. The page sends the same events as before (`perflo:setup_completed`
  and the rest), and Tiny accepts them only from the window Perflo.js placed, from the Perflo origin.
- **UI elements** (Tiny's own page). Tiny's own headings and buttons around Perflo's elements:
  1. **Sign in**: the code element, with Tiny's **Send code** and **Verify** buttons (`elements.sendCode()`,
     `elements.verifyCode()`). The code is typed inside the element and never reaches Tiny's page.
  2. **Allow Tiny to pay**: the limits element, shown once the code is verified. The person picks limits and presses
     Allow inside it. When it reports complete, Tiny's server picks up the access token as it does for the embedded page.
  3. **Add money**: the amount and payment elements, with Tiny's **Pay** button (`elements.confirmPayment()`), enabled
     only while both report `complete`. The button does not show an amount: the person types it inside the amount
     element, and it never passes through Tiny's page (the total shows inside the payment element).

  Element errors and load failures are shown in plain words (`web/src/elements.ts`). **Light** and **Dark** call
  `elements.update({ appearance: { theme } })` on every open element group, live. Embedded pages have no `update()`,
  so the switch is on the UI elements page only.

**Look.** The Payments panel has a **Look** picker with three example looks: Tiny's brand (the brand saved in Perflo
Builder, nothing sent), a flat light look (variables, condensed inputs, tabs on the payment form) and a dark look
(variables plus `rules` for inputs, labels and buttons, an accordion on the payment form). The browser sends only the
look's id; the `appearance` and `payment_element_options` Perflo gets come from the fixed list in `server/looks.ts`,
on the request that opens the page: `POST /v1/users`, `POST /v1/users/{id}/top-ups`, `POST /v1/users/{id}/limits-link`
and `POST /v1/checkout/orders` (`payment_element_options` only on the two that take a payment). They are signed like
every other request (`X-Partner-Key-Version` and the rest). A page already open keeps the look it was opened with,
and an order keeps the look it was made with, so a retry with its Idempotency-Key sends the same body.

**Content Security Policy.** The built app allows `script-src` and `frame-src` for the origin of `PERFLO_API_BASE` and
nothing else: `https://api.perflo.ai` in production, or whichever develop or staging host the demo is pointed at. No
host is written into the code. Perflo.js makes no network calls, so `connect-src` stays `'self'`.

**Mock mode** has no Perflo.js: pages open from their links as before, the Look picker is hidden and the UI elements
page says it needs live mode.

## Hosting (Railway or similar)

A host sets `PORT`, terminates HTTPS itself and has no `.env` file. With `PORT` set the demo
listens on that port over plain HTTP on every interface; without it, it runs on
`https://localhost:5174` as above. Mock mode only runs on this computer.

1. **Variables:** `DEMO_MODE=live`, `PERFLO_API_BASE` (`https://api.perflo.ai` in production), `PARTNER_ID`, `PARTNER_KEY_VERSION`,
   `PARTNER_SECRET`, `PERFLO_WEBHOOK_SECRET`. A `.env` file is read only when present and never replaces a variable the
   host already set.
2. **Build and start:** `npm ci --include=dev && npm run build`, then `npm start`. The build needs
   the dev dependencies (TypeScript, Vite).
3. **Frames:** add the host's address (for example `https://tiny-demo.up.railway.app`) to this
   partner's allowed origins in Perflo (Builder > Agent > Website embeds). Until then every Perflo
   frame answers 404 inside the demo.
   **Webhooks:** save `https://<the host's address>/webhooks/perflo` as the webhook address in Builder (for
   example `https://card-issuance-demo-production.up.railway.app/webhooks/perflo`), copy the secret it
   shows into `PERFLO_WEBHOOK_SECRET`, redeploy, then press **Send a test**.
4. **Data:** users, orders and access tokens live in `DEMO_DATA_FILE` (default
   `data/demo-store.json`). On a host without a volume that file is lost on every deploy, and
   people must connect again. Point `DEMO_DATA_FILE` at a mounted volume to keep it. A file that
   cannot be read or does not have the expected shape stops the server with a message naming it;
   Tiny never guesses its way past it.
5. **Origin:** set `DEMO_PUBLIC_ORIGIN` to the address people open (for example
   `https://tiny-demo.up.railway.app`). Every change request must come from it. Without it, the
   request's Origin must match the Host header the host forwards.
6. **Health and stop:** `GET /healthz` answers `{"status":"ok"}`. On SIGTERM running requests get
   up to 25 s to finish. Logs are one JSON object per line on stdout, each request with an id
   (also sent back as `X-Request-Id`).

A `Dockerfile` builds the same thing as one image (production dependencies only, a health check).
It runs as the unprivileged `node` user and keeps the store at `/data/demo-store.json`. On Railway,
add a Volume to the service with mount path `/data` so connections survive a deploy; the image has
no `VOLUME` line because Railway refuses one. Railway mounts a volume owned by root, so the
entrypoint (`scripts/docker-entrypoint.sh`) hands `/data` to `node` before starting. Do not set
`RAILWAY_RUN_UID=0`: that would run the whole server as root.

## How it talks to Perflo

Every call goes to `PERFLO_API_BASE` (`https://api.perflo.ai` in production). The shared routes
(users, logins, frames) are under `/v1`, for example `POST /v1/users`; the checkout routes are under
`/v1/checkout`, for example `POST /v1/checkout/orders`. The paths below leave out the `/v1` prefix.

- **Signing**: `server/signing.ts` mirrors `perflo-backend-api/src/partner/partnerSignature.ts` byte for
  byte. Headers `X-Partner-Id`, `X-Partner-Key-Version`, `X-Partner-Timestamp` (unix seconds),
  `X-Partner-Signature` = base64url HMAC-SHA256 of
  `keyVersion\nMETHOD\npath\ntimestamp\nsha256hex(raw body)`, path without the query string, over the exact
  bytes sent (a GET signs the empty body). Test vectors were computed independently in Python.
- **Users**: `POST /users` with only Tiny's own user id as `external_user_id`: no email and no name, because
  Tiny never asks for them. The person types and proves their email in the setup frame. `login_required`
  opens the setup frame in the chat, on the order that needs it (the first order, or the next one after access was removed); on `perflo:setup_completed` the server reads `GET /logins/{id}` and stores the token (it
  is handed out once). If Perflo says `approved` but Tiny holds no token, it asks with `reissue: true`.
- **Orders**: `POST /checkout/orders` with an `Idempotency-Key` fixed per chat order. Every retry is
  `GET /checkout/orders/{id}` (signature only, no token), never a second POST. Each status is handled:
  `ready` (read the card once through `reveal_url`, later reveals through `/card-reveal`), `payment_required`
  (add money frame; the order goes ahead when Perflo's webhook says so), `login_required` (setup frame, the
  order resumes on its own), `identity_check_required` (opens in a new tab; "try again" reads the order once),
  `issuing` (no webhook for it; the next one, `order.ready` or `order.failed`, moves it on), `declined`,
  `completed`, `cancelled`, `expired`, `failed`.
- **Webhooks** (`server/webhooks.ts`, `POST /webhooks/perflo`): the raw body is checked before anything parses
  it. `X-Perflo-Signature` = base64url HMAC-SHA256 with the webhook secret of
  `perflo-webhook-v1\n<X-Perflo-Key>\nPOST\n<path of the webhook address>\n<X-Perflo-Timestamp>\n<sha256hex(raw body)>`,
  compared in constant time; a timestamp more than 120 s from Tiny's clock is refused. `X-Perflo-Event-Id` is
  remembered in the store for 48 hours, so a retry of an event already handled is answered 200 and not acted
  on twice. A new event is answered 200 at once and acted on after: an `order.*` event reads
  `GET /checkout/orders/{id}` (the source of truth; the event body only says which order), does what that status
  needs (a ready card is checked out), and pushes the result to the person's open pages. `user.connected`
  tells the page of an account waiting on a sign-in to pick up the access (its own request, so its session
  is rotated as for any link); `user.disconnected` for the Perflo person an account is linked to makes Tiny
  ask Perflo whether its token still works and drop it if not. Neither links or unlinks anything by itself,
  and one that matches no account in that state is logged and ignored. `ping`
  (Builder's test) is logged. An event for an order this copy of Tiny did not place is logged and ignored.
- **Live updates** (`server/live.ts`, `GET /demo/stream`): Server-Sent Events for the session's own account:
  an order as the browser sees it, "access or balance changed", "connected", "new log lines". Nothing secret
  goes on it. The page reads its state once when it opens and once each time the stream comes back after a
  drop. A stream belongs to the session that opened it, not to the account: only the session cookie picks
  it (nothing in the query is read), it is closed when that session signs out or linking replaces it (the
  page opens it again with its new cookie), the session is checked again before every message, and a
  request another site started (`Sec-Fetch-Site` other than `same-origin`) is refused.
- **Cancel card**: `POST /checkout/orders/{id}/cancel` is safe to send again (a cancelled order answers what was
  recorded). While it answers 503 (payments busy, for example the card issuer briefly busy while it closes
  the card), or no answer comes in time, the page stays on "Cancelling..." and sends it again after 3, 6, 12,
  then every 20 seconds (longer if `Retry-After` asks), for about two minutes, then says calmly that it is
  taking longer and offers "Check again". The log shows a repeated refusal once. Any other refusal (the
  order already finished) is shown as it is. Logic in `web/src/cancel.ts`.
- **Replays**: Perflo never replays a token or a link. A `POST /users` replay has no token, so a reissue is
  asked with a new Idempotency-Key. A `card-reveal` replay (201 with only a message) is asked again with a new
  key, and a ready replay without `reveal_url` goes through `/card-reveal`. An identity check answer without
  `kyc_url` is followed by one `GET /checkout/orders/{id}`; if there is still no link, the chat says to try again in a
  minute.
- **Card reveal** (the contract in perflo-backend-api #345 and ms-card-issuance #94): Tiny reads a card
  with `GET reveal_url` exactly as given, signed like every partner call and carrying that person's
  access token: `X-Partner-Id`, `X-Partner-Key-Version`, `X-Partner-Timestamp` (unix seconds,
  within 120 s of Perflo's clock), `X-Partner-Signature` (HMAC-SHA256 with that key version's secret,
  base64url without padding) and `Authorization: Bearer <user_access_token>`. The signed string is the
  usual one: `<key version>\nGET\n<path of reveal_url without origin and without ?t=>\n<timestamp>\n`
  followed by the SHA-256 of the empty body (`e3b0c442...b855`). Any refusal is a 404 ("This link has
  expired or was already used.") and leaves the link usable until it expires. A 503 with
  `Retry-After: 5` means nothing was spent: Tiny tries once more after it, then says to try again. The
  token, the signature and the link are never logged. All of this is in one function,
  `revealCard()` in `server/checkout.ts`, and the mock enforces the same rules.
- **Errors**: every refusal code Perflo documents has a plain message and a next step for the person
  (`server/errors.ts`); when Tiny itself is at fault (wrong credentials or clock), the person gets a
  generic line and the operator's log says what to fix. Only reads are retried (up to three times, on no
  answer or 429, 502, 503, 504, honouring `Retry-After`).
- **Requests from the page**: every change request must carry Tiny's own Origin and a JSON body; the
  session cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and lasts 30 days; linking an account to
  Perflo gives the browser a new session id. The setup link goes only to the session that asked for it
  and never into the log, and a login is only ever completed for the session that started it.
- **Frames**: embedded with `allow="payment"`. Messages are accepted only from the `PERFLO_API_BASE` origin,
  from that frame's window, and only in the SPEC object shape.
- **Accounts**: a first visit gets an anonymous Tiny account (a session cookie, no personal details).
  Perflo's emailed code is what proves who the person is. Once an account links to a Perflo user that an
  earlier Tiny account already linked to, it is the same person, so the earlier account's orders move onto the
  new one.
- **Requests**: nothing polls. While an order waits on payments (a card getting ready, money arriving, an
  identity check result) the page shows that Tiny is waiting and asks nothing; Perflo's webhook brings the
  change. If none has come after a few minutes the page says it is taking longer than usual, and "Check again"
  reads the order once. The balance is read after an order changes status, a card is cancelled, money or
  limits are saved, and when the tab comes back into view. The one loop left is the cancel, which only sends
  the cancel itself again while payments is busy.
- **Orders tab**: the same list as the chat. Opening the tab reads it once; orders that are still moving are
  read again from Perflo first (`GET /checkout/orders/:id`, never a new order).

## Scripts

| Command             | What it does                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run dev`       | Server with Vite in middleware mode on https://localhost:5174 (plus the mock in mock mode)         |
| `npm test`          | vitest: signing, intent parsing, order states, redaction, frame events, the mock, end-to-end flows |
| `npm run typecheck` | strict TypeScript for server, web and tests                                                        |
| `npm run lint`      | ESLint (type-aware) over server, web and tests                                                     |
| `npm run format`    | Prettier (`format:check` only checks); CI runs typecheck, lint, format check, tests, build, audit  |
| `npm run build`     | compiles the server to `dist/server` and the web app to `dist/web`                                 |
| `npm start`         | runs the build (`NODE_ENV=production`)                                                             |
| `npm run cert`      | creates `certs/localhost.pem` and `certs/localhost-key.pem`                                        |

## Layout

```
server/
  index.ts        starts the demo (and the mock), https on 5174
  app.ts          the /demo routes the browser calls
  service.ts      the partner flow: link, logins, orders, card, cancel, links
  perfloApi.ts    signed, validated Partner API v2 client
  signing.ts      canonical string, HMAC, verification
  webhooks.ts     webhook signature check and event shape
  live.ts         pushes changes to the person's open pages (Server-Sent Events)
  checkout.ts     card reveal (revealCard) and the simulated checkout
  errors.ts       what the browser is told for each failure
  security.ts     response headers, same-origin check, rate limit
  looks.ts        the example looks (appearance, payment_element_options) Tiny sends Perflo
  logger.ts       JSON logs with request ids
  orderState.ts   pure status handling and the browser view
  intent.ts       the scripted assistant's parser
  store.ts        JSON file store (owner-only, holds tokens)
  redact.ts       the one redactor for logs
  views.ts        shapes shared with the web app
  mock/           mock Perflo API, frames, identity check, card relay, shop
web/src/          chat, order cards, Perflo page wrapper (PerfloFrame), UI elements page (ElementsPage),
                  Perflo.js loader (perflo.ts), payments panel
test/             vitest suites
```

`data/`, `certs/` and `.env` are git-ignored. `data/demo-store.json` holds access tokens: delete it to start
over.
