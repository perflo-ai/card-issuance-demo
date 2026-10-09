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

`npm run dev` starts the test payments service on `PERFLO_API_BASE` as well. Its state is in memory, so a
restart starts it fresh (the demo's own store in `data/` is kept: sign out and set up payments again after a
restart).

Things to try, in order:

1. Open the demo. Tiny asks for nothing about you: the first screen is **Set up payments**. The frame asks
   for your email and the code (test code **123456**), then for your limits.
2. `buy me $50 worth of headphones on amazon`, then confirm.
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

Each order in the chat lists its steps (identity check and adding money only when the order asked for them)
and says what Tiny is doing or waiting for right now, from the statuses payments returned.

The developer log at the bottom of the panel shows every call Tiny's server made and every frame event,
with access tokens, card details and link codes removed. A status read that gets the same answer as the line
before it is not repeated, so the log shows one line per change. It reads new lines after each request the page
makes, not on a timer.

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
```

1. Have a Builder agent (the partner row) and create its credentials with
   `POST /v1/agents/:agent_id/partner-credentials`. The secret is shown once; put it in `.env`.
2. Allow the demo to embed frames: `PUT /v1/agents/:agent_id/allowed-origins` with
   `{"allowed_origins":["https://localhost:5174"]}` (the dev seed already registers this origin).
3. Point `PERFLO_API_BASE` at the backend:
   - a local `perflo-backend-api` with `PARTNER_V2_ENABLED=true`: `http://localhost:3001`. Its `.env` points
     at production, so run it only with a development or staging configuration.
   - a staging or develop host that runs the partner v2 build. Check it serves `/partner/v2` before
     pointing the demo at it. Never point the demo at production.
4. `npm run dev`.

In live mode Tiny never buys anything: there is no real shop. After the card details are read, it fills a
checkout form in memory and stops, and says so in the chat. The card stays open until you cancel it or it
expires after 12 hours, and unused money goes back to the balance either way. A live order still moves
real money from the balance onto the card, so use test accounts.

The right panel has two tabs. **Payments** is the balance, limits and money controls. **Orders** lists every
order sent to payments, newest first, with its status, what was paid or returned, and for an open card the
card itself (number and security code hidden until "Show card details") and a Cancel card button.

Frames from an `http://localhost` backend embedded in the https demo page are mixed content. Chrome and
Firefox treat `localhost` as trustworthy; Safari may block them. This was not verified in a browser.

## Hosting (Railway or similar)

A host sets `PORT`, terminates HTTPS itself and has no `.env` file. With `PORT` set the demo
listens on that port over plain HTTP on every interface; without it, it runs on
`https://localhost:5174` as above. Mock mode only runs on this computer.

1. **Variables:** `DEMO_MODE=live`, `PERFLO_API_BASE`, `PARTNER_ID`, `PARTNER_KEY_VERSION`,
   `PARTNER_SECRET`. A `.env` file is read only when present and never replaces a variable the
   host already set.
2. **Build and start:** `npm ci --include=dev && npm run build`, then `npm start`. The build needs
   the dev dependencies (TypeScript, Vite).
3. **Frames:** add the host's address (for example `https://tiny-demo.up.railway.app`) to this
   partner's allowed origins in Perflo (Builder > Agent > Website embeds). Until then every Perflo
   frame answers 404 inside the demo.
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

A `Dockerfile` builds the same thing as one image (production dependencies only, unprivileged
user, the store on a `/data` volume, a health check).

## How it talks to Perflo

- **Signing**: `server/signing.ts` mirrors `perflo-backend-api/src/partner/partnerSignature.ts` byte for
  byte. Headers `X-Partner-Id`, `X-Partner-Key` (the key version), `X-Partner-Timestamp` (unix seconds),
  `X-Partner-Signature` = base64url HMAC-SHA256 of
  `keyVersion\nMETHOD\npath\ntimestamp\nsha256hex(raw body)`, path without the query string, over the exact
  bytes sent (a GET signs the empty body). Test vectors were computed independently in Python.
- **Users**: `POST /users` with only Tiny's own user id as `external_user_id`: no email and no name, because
  Tiny never asks for them. The person types and proves their email in the setup frame. `login_required`
  opens the setup frame (first on the connect screen, later in the chat if access was removed); on `perflo:setup_completed` the server reads `GET /logins/{id}` and stores the token (it
  is handed out once). If Perflo says `approved` but Tiny holds no token, it asks with `reissue: true`.
- **Orders**: `POST /orders` with an `Idempotency-Key` fixed per chat order. Every retry is
  `GET /orders/{id}` (signature only, no token), never a second POST. Each status is handled:
  `ready` (read the card once through `reveal_url`, later reveals through `/card-reveal`), `payment_required`
  (add money frame, then look again after `perflo:top_up_completed`), `login_required` (setup frame, the
  order resumes on its own), `identity_check_required` (opens in a new tab, then try again), `issuing`
  (looks again after 2 seconds, then a little longer each time up to 10 seconds, for up to five minutes),
  `declined`, `completed`, `cancelled`, `expired`, `failed`.
- **Replays**: Perflo never replays a token or a link. A `POST /users` replay has no token, so a reissue is
  asked with a new Idempotency-Key. A `card-reveal` replay (201 with only a message) is asked again with a new
  key, and a ready replay without `reveal_url` goes through `/card-reveal`. An identity check answer without
  `kyc_url` is followed by one `GET /orders/{id}`; if there is still no link, the chat says to try again in a
  minute.
- **Card reveal** (the contract in perflo-backend-api #345 and ms-card-issuance #94): Tiny reads a card
  with `GET reveal_url` exactly as given, signed like every partner call and carrying that person's
  access token: `X-Partner-Id`, `X-Partner-Key` (the key version), `X-Partner-Timestamp` (unix seconds,
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
- **Requests**: the page asks only when something can have changed. Nothing is read on a timer while the page
  is quiet. While an order waits on payments (a card getting ready, money arriving, an identity check result)
  one look runs at a time, the wait between looks grows, looking pauses while the tab is hidden, and it stops
  at the answer or after its time limit (then a "Check again" button). The balance is read after an order
  changes status, a card is cancelled, money or limits are saved, and when the tab comes back into view.
- **Orders tab**: the same list as the chat. Opening the tab reads it once; orders that are still moving are
  read again from Perflo first (`GET /orders/:id`, never a new order).

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
  checkout.ts     card reveal (revealCard) and the simulated checkout
  errors.ts       what the browser is told for each failure
  security.ts     response headers, same-origin check, rate limit
  logger.ts       JSON logs with request ids
  orderState.ts   pure status handling and the browser view
  intent.ts       the scripted assistant's parser
  store.ts        JSON file store (owner-only, holds tokens)
  redact.ts       the one redactor for logs
  views.ts        shapes shared with the web app
  mock/           mock Perflo API, frames, identity check, card relay, shop
web/src/          chat, order cards, Perflo frame wrapper, payments panel
test/             vitest suites
```

`data/`, `certs/` and `.env` are git-ignored. `data/demo-store.json` holds access tokens: delete it to start
over.
