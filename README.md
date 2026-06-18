# Hoomri Backend — NestJS API

Enterprise-grade backend for the Hoomri social-SME multi-shop commerce platform.

## Stack

| Layer | Choice |
|---|---|
| Framework | NestJS 11 |
| Database | PostgreSQL 16 (Docker) |
| ORM | Drizzle ORM + drizzle-kit migrations |
| Auth | Passport JWT (seller) · Passport JWT (admin, separate secret) · passport-google-oauth20 · otplib TOTP 2FA |
| Validation | class-validator + class-transformer (global ValidationPipe) |
| Docs | Swagger / OpenAPI at `/api/docs` |
| Security | helmet · @nestjs/throttler · CORS · shop-scope tenant isolation |

## Quick start

```bash
# 1. Copy env
cp .env.example .env          # secrets auto-generated on first copy

# 2. Start Postgres
pnpm db:up                    # docker compose up -d postgres

# 3. Migrate
pnpm db:migrate

# 4. Seed (Mango Shop demo dataset)
pnpm db:seed

# 5. Run dev server
pnpm start:dev
```

API: `http://localhost:3000/api`
Swagger: `http://localhost:3000/api/docs`

## Seed credentials

```
Seller login
  email:    maya@mango-shop.com
  password: password123

Storefront (public)
  GET /api/shops/mango-shop

Admin console (workspace = mango-shop)
  email:    maya@mango-shop.com
  password: admin12345
  2FA:      see TOTP secret printed by `pnpm db:seed`
```

## Project structure

```
src/
├── config/
│   ├── configuration.ts        # namespaced @nestjs/config slices
│   └── env.validation.ts       # boot-time env validation (class-validator)
├── database/
│   ├── schema/                 # Drizzle table + enum definitions
│   │   ├── enums.ts            # all pg enums + derived TS union types
│   │   ├── users.schema.ts
│   │   ├── shops.schema.ts
│   │   ├── admin-users.schema.ts
│   │   ├── products.schema.ts
│   │   ├── reviews.schema.ts
│   │   ├── customers.schema.ts
│   │   ├── orders.schema.ts    # orders + order_items
│   │   └── index.ts            # barrel (imported by drizzle-kit + provider)
│   ├── migrations/             # generated SQL migrations
│   ├── database.module.ts      # Global Drizzle provider (DRIZZLE token)
│   ├── drizzle.types.ts        # DrizzleDB / DrizzleTx / DbExecutor types
│   ├── migrate.ts              # pnpm db:migrate runner
│   └── seed.ts                 # pnpm db:seed (Mango Shop demo data)
├── common/
│   ├── constants/brand-swatches.ts   # 6 per-shop color swatches
│   ├── decorators/             # @Public, @CurrentUser, @Roles
│   ├── filters/                # AllExceptionsFilter (uniform JSON envelope)
│   ├── guards/                 # JwtAuthGuard, AdminJwtAuthGuard, RolesGuard, ShopScopeGuard
│   ├── interceptors/           # LoggingInterceptor
│   ├── types/principal.ts      # SellerPrincipal | AdminPrincipal
│   ├── dto/pagination-query.dto.ts
│   └── utils/                  # money (cents<->dollars), slug (handleize)
└── modules/
    ├── auth/                   # Seller + admin auth, Google OAuth, phone OTP, 2FA
    ├── users/                  # UsersService (platform accounts)
    ├── shops/                  # Storefront CRUD + handle-availability check
    ├── products/               # Catalog + admin items; reviews on product detail
    ├── orders/                 # Inline checkout (transaction) + admin pipeline
    ├── customers/              # Lifetime aggregation, segmentation (VIP/Repeat/New)
    ├── reports/                # Dashboard KPIs, 12-mo revenue series, repeat-buyer report, CSV export
    └── health/                 # /api/health liveness probe
```

## API reference

### Auth — `/api/auth`

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Seller email registration |
| POST | `/auth/login` | Seller email login |
| POST | `/auth/phone/start` | Send phone OTP |
| POST | `/auth/phone/verify` | Verify OTP → token |
| GET | `/auth/google` | Google OAuth redirect |
| GET | `/auth/google/callback` | OAuth callback → Vue redirect with `?token=` |
| GET | `/auth/me` | Hydrate seller principal (Bearer) |
| POST | `/auth/logout` | Stateless (client discards token) |
| POST | `/auth/admin/login` | Admin stage 1 → 2FA ticket |
| POST | `/auth/admin/2fa` | Admin stage 2 TOTP → admin-scoped JWT |

### Shops

| Method | Path | Auth |
|---|---|---|
| GET | `/shops/check-handle?handle=` | Public |
| POST | `/shops` | Seller JWT |
| GET | `/shops/mine` | Seller JWT |
| GET | `/shops/:handle` | Public (storefront + featured products) |
| PATCH | `/shops/:id` | Seller JWT (owner only) |

### Products

| Method | Path | Auth |
|---|---|---|
| GET | `/shops/:handle/products?cat=` | Public |
| GET | `/shops/:handle/products/:slug` | Public (+ reviews + rating distribution) |
| GET | `/shops/:shopId/items` | Admin JWT |
| POST | `/shops/:shopId/products` | Admin JWT |
| PATCH | `/shops/:shopId/products/:id` | Admin JWT |
| DELETE | `/shops/:shopId/products/:id` | Admin JWT |

### Orders

| Method | Path | Auth |
|---|---|---|
| POST | `/checkout` | Public (buyer) |
| GET | `/shops/:shopId/orders?status=&channel=` | Admin JWT |
| GET | `/shops/:shopId/orders/:id` | Admin JWT |
| PATCH | `/shops/:shopId/orders/:id/status` | Admin JWT |
| POST | `/shops/:shopId/orders/:id/refund` | Admin JWT |

### Customers + Reports

| Method | Path | Auth |
|---|---|---|
| GET | `/shops/:shopId/customers?segment=` | Admin JWT |
| GET | `/shops/:shopId/customers/:id` | Admin JWT (+ order history) |
| GET | `/shops/:shopId/dashboard` | Admin JWT |
| GET | `/shops/:shopId/reports/repeat-buyers` | Admin JWT |
| GET | `/shops/:shopId/reports/export` | Admin JWT (CSV download) |

## Security design

- **Two separate JWT secrets** — seller tokens and admin tokens share no signing key.
- **2FA ticket** — a third, short-lived (5 min) JWT bridges admin credential and TOTP stages. The full admin-scoped JWT is only issued after TOTP verification.
- **`@Public()` decorator** — globally registered `JwtAuthGuard` skips public routes, so storefront/product/checkout endpoints need no token.
- **`ShopScopeGuard`** — admin routes with a `:shopId` param assert it matches the shop embedded in the JWT, preventing cross-tenant access.
- **Server-side money** — all totals (incl. COD fee) computed server-side; never trusted from the client.
- **Server-side segmentation** — `VIP / Repeat / New` derived from lifetime order count and spend.

## Scripts

```bash
pnpm start:dev        # watch mode
pnpm build            # nest build -> dist/
pnpm start:prod       # node dist/src/main.js
pnpm db:up            # docker compose up -d postgres
pnpm db:down          # docker compose down
pnpm db:generate      # drizzle-kit generate (after schema changes)
pnpm db:migrate       # apply pending migrations
pnpm db:push          # push schema directly (dev only)
pnpm db:studio        # Drizzle Studio browser UI
pnpm db:seed          # seed Mango Shop demo data
pnpm test             # jest unit tests
pnpm test:e2e         # e2e tests
```

## Environment

Copy `.env.example` → `.env` and fill in:

- `DATABASE_URL` — Postgres connection string
- `JWT_SECRET` / `ADMIN_JWT_SECRET` / `ADMIN_2FA_TICKET_SECRET` — strong random values
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — leave blank to disable Google OAuth
- `CORS_ORIGINS` — comma-separated Vue app origins
