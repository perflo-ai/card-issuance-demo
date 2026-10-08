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
restart starts it fresh (the demo's own store in `data/` is kept: sign up again after a restart).

Things to try, in order:

1. Sign up with any name and email.
2. `buy me $50 worth of headphones on amazon`, then confirm. Tiny asks you to set up payments once: the
   frame asks for the code (test code **123456**), then for your limits.
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

The developer log at the bottom of the panel shows every call Tiny's server made and every frame event,
with access tokens, card details and link codes removed.

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

## How it talks to Perflo

- **Signing**: `server/signing.ts` mirrors `perflo-backend-api/src/partner/partnerSignature.ts` byte for
  byte. Headers `X-Partner-Id`, `X-Partner-Key` (the key version), `X-Partner-Timestamp` (unix seconds),
  `X-Partner-Signature` = base64url HMAC-SHA256 of
  `keyVersion\nMETHOD\npath\ntimestamp\nsha256hex(raw body)`, path without the query string, over the exact
  bytes sent (a GET signs the empty body). Test vectors were computed independently in Python.
- **Users**: `POST /users` with Tiny's own user id as `external_user_id`. `login_required` opens the setup
  frame in the chat; on `perflo:setup_completed` the server reads `GET /logins/{id}` and stores the token (it
  is handed out once). If Perflo says `approved` but Tiny holds no token, it asks with `reissue: true`.
- **Orders**: `POST /orders` with an `Idempotency-Key` fixed per chat order. Every retry is
  `GET /orders/{id}` (signature only, no token), never a second POST. Each status is handled:
  `ready` (read the card once through `reveal_url`, later reveals through `/card-reveal`), `payment_required`
  (add money frame, then look again after `perflo:top_up_completed`), `login_required` (setup frame, the
  order resumes on its own), `identity_check_required` (opens in a new tab, then try again), `issuing`
  (looks again every 2 seconds), `declined`, `completed`, `cancelled`, `expired`, `failed`.
- **Replays**: Perflo never replays a token or a link. A `POST /users` replay has no token, so a reissue is
  asked with a new Idempotency-Key. A `card-reveal` replay (201 with only a message) is asked again with a new
  key, and a ready replay without `reveal_url` goes through `/card-reveal`. An identity check answer without
  `kyc_url` is followed by one `GET /orders/{id}`; if there is still no link, the chat says to try again in a
  minute.
- **Frames**: embedded with `allow="payment"`. Messages are accepted only from the `PERFLO_API_BASE` origin,
  from that frame's window, and only in the SPEC object shape.
- **Sign-up**: Tiny never re-attaches an account by email. Each sign-up is a new person; Perflo's emailed
  code is what proves the email. Once a new account links to a Perflo user that an earlier Tiny account
  already linked to, it is the same person, so the earlier account's orders move onto the new one.
- **Orders tab**: before listing, orders that are still moving are read again from Perflo (`GET /orders/:id`,
  never a new order). The chat keeps checking a card that is getting ready for up to five minutes.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server with Vite in middleware mode on https://localhost:5174 (plus the mock in mock mode) |
| `npm test` | vitest: signing, intent parsing, order states, redaction, frame events, the mock, end-to-end flows |
| `npm run typecheck` | strict TypeScript for server, web and tests |
| `npm run build` | compiles the server to `dist/server` and the web app to `dist/web` |
| `npm start` | runs the build (`NODE_ENV=production`) |
| `npm run cert` | creates `certs/localhost.pem` and `certs/localhost-key.pem` |

## Layout

```
server/
  index.ts        starts the demo (and the mock), https on 5174
  app.ts          the /demo routes the browser calls
  service.ts      the partner flow: link, logins, orders, card, cancel, links
  perfloApi.ts    signed, validated Partner API v2 client
  signing.ts      canonical string, HMAC, verification
  checkout.ts     card reveal and the simulated checkout
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
