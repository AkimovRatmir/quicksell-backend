# QuickSell — analytics for Kaspi.kz sellers (backend)

QuickSell was a SaaS product for sellers on [Kaspi.kz](https://kaspi.kz), Kazakhstan's largest
marketplace. A seller connected their store, and QuickSell showed what Kaspi's own cabinet doesn't:
real profit after Kaspi commission, delivery, packaging and cost of goods, which products earn and
which lose money, a unit-economics calculator, and AI recommendations.

It ran in production in September 2026 (freemium: Free plan + Pro at 15 000 ₸/month) and has since
been shut down. The code is published as a portfolio project.

Frontend: [quicksell-frontend](https://github.com/AkimovRatmir/quicksell-frontend) · React + TypeScript

## What's interesting here

**Kaspi integration through two channels**
- Orders come through Kaspi's official Shop API (per-seller API token): an 89-day backfill on
  connect, then a nightly incremental sync of the 14-day return window.
- Products come from the seller cabinet, which has no public API. The backend signs in with the
  seller's login, handles Kaspi's emailed one-time code and device trust, and re-logs in on its own
  when the session expires. When Kaspi asks for a new code it pauses automatic re-logins instead of
  triggering an email on every hourly sync.
- Kaspi credentials and cookies are encrypted at rest (AES-256-GCM).
- Syncs run with bounded concurrency across sellers and per order. Line items are refetched only
  for orders whose status or total changed. Failed fetches are retried, and gaps left by a network
  drop are filled on the next sync.

**Profit analytics**
- Profit per order and per product: Kaspi commission, delivery, packaging, taxes and custom expense
  categories, with cost-of-goods history per product.
- Product statistics (ABC, profit concentration, dead stock), a unit-economics calculator with a
  monthly free-plan limit, and AI insights generated with OpenAI. Insights are cached per store and
  period, with a cooldown on forced refreshes and concurrent requests sharing one call.

**Subscription payments (FreedomPay)**
- The payment form opens in a popup on our own page (the provider's hosted form in an iframe), so
  card data never touches our servers.
- Pro is granted only on the provider's word: a signed server-to-server callback (MD5 signature
  checked in constant time) or our own status lookups. Amount, currency and test mode must match
  what we created, and each payment grants Pro exactly once, even if callbacks repeat or race.
- A scheduler reconciles payments whose outcome never arrived and moves expired plans back to Free.

**Accounts and security**
- JWT auth. Resetting a password invalidates every token issued before it. Reset links use
  SHA-256-hashed one-time tokens and are sent through Resend.
- Per-user rate limits on everything that talks to Kaspi or costs money.
- A versioned, append-only log of legal consents (offer, privacy policy, payment terms) with
  timestamp, IP and user agent, written in the same transaction as the account.
- Internal admin panel API: users, plans, store health.
- Swagger is behind HTTP Basic auth in production, and the API listens on loopback behind nginx.

**Operations.** It ran on one VPS: nginx with Let's Encrypt, the API under systemd, Postgres in
Docker, nightly backups and fail2ban. The full runbook is in [DEPLOY.md](DEPLOY.md).

## Stack

TypeScript · NestJS 11 · Bun · PostgreSQL · Drizzle ORM (SQL migrations) · Passport JWT ·
@nestjs/schedule · @nestjs/throttler · Swagger · OpenAI API · Resend · FreedomPay

## Structure

| Module | What it does |
|---|---|
| `src/kaspi` | Store connection, cabinet login and MFA, product and order sync, schedulers |
| `src/analytics` | Profit, product statistics, unit economics, AI insights, expense settings |
| `src/billing` | FreedomPay checkout, signed callbacks, reconciliation, plan expiry |
| `src/auth` | Registration, login, JWT, password reset, rate-limit guards |
| `src/legal` | Legal document registry and the consent audit log |
| `src/admin` | Admin panel API |
| `src/mail` | Transactional email (Resend) |
| `src/crypto` | Password hashing and credential encryption |
| `drizzle/` | Database migrations |

## Running locally

Requires [Bun](https://bun.sh) and Docker.

```bash
bun install
bash scripts/generate-secrets.sh   # creates .env from .env.example with fresh secrets
docker compose up -d               # Postgres on localhost:5432
bun run db:migrate
bun run dev                        # http://localhost:3000, API docs at /docs
```

Connecting a store needs a real Kaspi seller account, and AI insights, email and payments need their
own API keys in `.env` (see `.env.example`). Without them those features answer with a clear error.

## Authors

- **Ratmir Akimov**: backend, Kaspi integration, payments, deployment
- **Vladislav Shivarev**: frontend design and UI

## License

All rights reserved. The code is published for viewing only. See [LICENSE](LICENSE).
