# AURA Jewellery - E-Commerce Platform (Polyglot Microservices)

A comprehensive, feature-rich e-commerce platform for luxury jewellery. The project consists of a modern Single Page Application (React) and a highly robust, microservices-based backend utilizing a Polyglot Persistence architecture (PostgreSQL + MongoDB).

---

# 🏗️ Part 1: Backend Architecture & Database Design

The backend system is designed as a kiosk ordering point. It implements the **Saga Pattern** to maintain consistency between a relational store (PostgreSQL) and a document store (MongoDB).

## 🧩 Microservices Breakdown

| Service | Port | Stack | Responsibility |
|---|---|---|---|
| `api-gateway` | 3000 | Express + Zod + axios + swagger-ui-express | Public entry point. Routing, input validation, distributed saga orchestration, response aggregation, OpenAPI docs, unified error envelope. |
| `pg-service` (Inventory & Order) | 3001 | Express + pg + Knex + Sequelize + Prisma | ACID catalog: **`products`**, **`categories`**, relational **`variants` (SKU, price, stock)**, **`inventory_movements`** audit, carts + **`Order`/`OrderLine` price+SKU snapshots**, checkout **`FOR UPDATE` on `variants`**. |
| `mongo-service` (Catalog & Analytics) | 3002 | Express + mongodb native + Mongoose | All flexible/document data: extended product details with variants (`ProductDetail`), reviews with moderation history (`Review`), user wishlists, analytics aggregations. |
| `seeder` (one-shot) | n/a | Reuses api-gateway image | Posts 18 base products through the gateway once both services are healthy. Exits after completion so `docker compose up` requires zero manual steps. |
| `frontend` | 5173 | React 18 + Vite | Customer storefront + admin panel. Out of scope for the database course grading. |

Backing stores:

| Store | Image | Purpose |
|---|---|---|
| `postgres` | postgres:15-alpine | Relational engine for transactional data. |
| `mongodb` | mongo:6 | Document engine for flexible domain data and analytics. |

## 🗺️ System Architecture (Component Diagram)

```mermaid
flowchart LR
    subgraph public ["Public network"]
        Client["Client<br/>(browser / Postman)"]
    end

    subgraph docker ["docker compose network"]
        GW["api-gateway :3000<br/>Express + Zod + axios"]
        PG_SVC["pg-service :3001<br/>Express + pg/Knex/Sequelize/Prisma"]
        MG_SVC["mongo-service :3002<br/>Express + native + Mongoose"]
        SEED["seeder<br/>(one-shot)"]

        subgraph datastores ["Datastores"]
            PG[("PostgreSQL :5432<br/>products, categories,<br/>variants, inventory_movements,<br/>Carts, CartLines,<br/>Order, OrderLine")]
            MG[("MongoDB :27017<br/>catalog docs: productdetails, reviews<br/>native ops: wishlists")]
        end
    end

    Client --HTTP--> GW
    GW --HTTP--> PG_SVC
    GW --HTTP--> MG_SVC
    SEED -.HTTP.-> GW
    PG_SVC --TCP--> PG
    MG_SVC --TCP--> MG
```

Each microservice owns exactly one database engine. The gateway never talks to a database directly - it always goes through one of the two domain services.

## 🔁 Data Flow — Hybrid Product Creation Saga (PG + Mongo with Compensation)

This is the canonical "write to both databases" flow. It demonstrates how the saga keeps the two stores consistent even though there is no shared transaction manager.

```mermaid
sequenceDiagram
    participant C as Client
    participant G as api-gateway
    participant PG as pg-service
    participant MG as mongo-service

    C->>G: POST /api/products { name, sku, price, variants, ... }
    G->>G: Zod validation
    G->>PG: POST /internal/products (step 1: insert base row)
    alt PG insert fails (e.g. SQLSTATE 23505 unique sku)
        PG-->>G: 409 / 400 { error, code, details }
        G-->>C: 409 / 400 unified envelope (no compensation needed)
    else PG insert OK
        PG-->>G: 201 { id }
        G->>PG: POST /internal/products/:id/variants (sku / price / stock rows)
        PG-->>G: 204
        G->>MG: POST /internal/product-details (step 3: insert document)
        alt Mongo insert fails (Mongoose validator, duplicate productId, ...)
            MG-->>G: 4xx { error }
            G->>PG: DELETE /internal/products/:id (compensation — cascades variants)
            PG-->>G: 204
            G-->>C: 4xx { error, code, details: { rollbackStatus: "success" } }<br/>with header X-Rollback-Status: success
        else Mongo insert OK
            MG-->>G: 201
            G-->>C: 201 { id, message: "product created in both databases" }
        end
    end
```

## 🔁 Data Flow — Transactional Checkout (PG Prisma transaction)

```mermaid
sequenceDiagram
    participant C as Client
    participant G as api-gateway
    participant PG as pg-service (Prisma)

    C->>G: POST /api/checkout { userId, items }
    G->>G: Zod validation
    G->>PG: POST /checkout
    PG->>PG: prisma.$transaction (BEGIN)
    PG->>PG: SELECT variants ... FOR UPDATE (row lock)
    alt Stock < requested
        PG-->>G: 409 conflict_oversell
        G-->>C: 409 unified envelope
    else Stock OK
        PG->>PG: UPDATE variants.stock, INSERT inventory_movements, INSERT Order and OrderLines
        PG->>PG: COMMIT (rollup products.stock)
        PG-->>G: 201 { orderId }
        G-->>C: 201 { success: true, orderId }
    end
```

The cancel flow (`POST /api/orders/:id/cancel`) is the symmetric inverse: it updates `Order.status = CANCELLED`, restores **`variants.stock`**, writes compensating **`inventory_movements`**, and rollup-syncs `products.stock` — all inside another Prisma transaction.

## 🚀 Running the Backend (Docker Compose)

The entire stack is fully containerized. **`docker compose up` requires zero manual steps** - migrations, seeds and product population happen automatically.

1. Clone the repository and enter the folder:
```bash
git clone https://github.com/zofiadobrowolskaa/ecommerce-spa.git
cd ecommerce-spa
```

2. Make sure Docker and Docker Compose are installed.

3. Copy the env template and adjust values if needed:
```bash
cp .env.example .env
```

4. Build and start the whole stack:
```bash
docker compose up -d --build
```

What happens on first start:
- `postgres` and `mongodb` boot, become `healthy`.
- `pg-service` waits for `postgres healthy`, then runs `prisma migrate deploy && knex migrate:latest && knex seed:run` before opening port 3001.
- `mongo-service` waits for `mongodb healthy`, then creates required indexes (text + compound) before opening port 3002.
- `api-gateway` waits for **both** microservices to be `healthy`, then opens port 3000.
- `seeder` (one-shot) waits for `api-gateway healthy`, posts 18 products through the gateway saga (populating both Postgres and MongoDB), then exits.

5. Verify the stack:
```bash
docker compose ps -a        # all services Up / healthy, seeder Exited (0)
```

6. Access the system:
- **API Gateway:** http://localhost:3000
- **Swagger UI (OpenAPI Docs):** http://localhost:3000/api-docs
- **Inventory Service (internal):** http://localhost:3001
- **Catalog Service (internal):** http://localhost:3002

## ⚙️ Environment Variables

A documented template lives in [`.env.example`](.env.example). Copy it to `.env` before the first `docker compose up`.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `POSTGRES_USER` | `user` | postgres, pg-service | Postgres credentials |
| `POSTGRES_PASSWORD` | `password` | postgres, pg-service | Postgres credentials |
| `POSTGRES_DB` | `ecommerce_db` | postgres, pg-service | Postgres database name |
| `MONGO_INITDB_ROOT_USERNAME` | `admin` | mongodb | Mongo admin user |
| `MONGO_INITDB_ROOT_PASSWORD` | `password` | mongodb | Mongo admin password |
| `MONGO_URI` | `mongodb://admin:password@mongodb:27017/ecommerce_db?authSource=admin` | mongo-service | Mongoose / native driver connection string |
| `API_GATEWAY_PORT` | `3000` | compose | Host port exposing the gateway |
| `INVENTORY_SERVICE_PORT` | `3001` | compose | Host port exposing pg-service |
| `CATALOG_SERVICE_PORT` | `3002` | compose | Host port exposing mongo-service |
| `FRONTEND_PORT` | `5173` | compose | Host port exposing the SPA |
| `INVENTORY_SERVICE_URL` | `http://pg-service:3001` | api-gateway | Internal service discovery URL |
| `CATALOG_SERVICE_URL` | `http://mongo-service:3002` | api-gateway | Internal service discovery URL |

## 📡 API Documentation (OpenAPI / Swagger)

The gateway exposes a fully interactive **OpenAPI 3.0** contract documenting endpoints, request bodies, query parameters, response shapes (including the unified `{ error, code, details }` envelope) and the `X-Rollback-Status` saga header.

- **Swagger UI (interactive):** http://localhost:3000/api-docs
- **Raw spec (publishable JSON):** http://localhost:3000/api-docs.json

Download the spec and feed it to any OpenAPI tooling:

```bash
curl http://localhost:3000/api-docs.json > openapi.json
# can be imported to Postman, fed to openapi-generator-cli, rendered by ReDoc, etc.
```

## 🛠️ Database Technologies & ORMs (Polyglot Implementation)

The backend uses **seven** distinct database interaction paradigms in clearly separated bounded contexts:

**PostgreSQL side (pg-service):**
1. **`pg` native driver** – Singleton pool, parameterized queries (`$1, $2`), SQLSTATE → HTTP mapping (`23505` → 409, `23503` → 400). Powers **`variants`** stock adjustments (`PATCH /inventory/:sku`) with mirrored rollup on `products.stock`.
2. **Knex.js** – Schema migrations and domain seeds (categories). **`variants`** + **`inventory_movements`** additive migrations. Dynamic `WHERE` builder for product catalog filtering (no string concatenation, parameters bound by the builder).
3. **Sequelize v6** – Server-side cart (`Cart`, `CartLine`) with explicit model validators, eager loading via `include`, domain hooks (`beforeValidate`, `afterSave`) and managed transactions.
4. **Prisma ORM** – Order header / order line schema with relations (**SKU + unit price snapshots** on each line), migration history (`prisma migrate deploy` runs at container start), full CRUD via typed model API, `$queryRaw` tagged templates **`FOR UPDATE` row locks on `variants`** during checkout and analytics queries.

**MongoDB side (mongo-service):**

5. **MongoDB native driver** – Singleton `MongoClient`, graceful shutdown on `SIGINT` / `SIGTERM`, user `wishlists` managed exclusively by the native driver using 4 distinct operators (`$push`, `$inc`, `$set`, `$pull`). Compound index `{ userId, lastModified }` + text index on wishlist notes.
6. **Mongoose** – `ProductDetail` and `Review` schemas with custom validators (rating must be integer, body must have ≥ 3 words, variants must have unique colors), nested subdocuments (`variants[]`, `gallery[]`, `moderationHistory[]`), pre-save hook, virtual populate, statics (`findByProduct`) and instance methods (`approve()`, `reject()`).
7. **Aggregation Pipeline** – 7-stage analytics report (`$match` → `$group` → `$lookup` → `$unwind` → `$sort` → `$limit` → `$project`). First `$match` is backed by a compound index `{ status, productId }` so the planner uses `IXSCAN` instead of `COLLSCAN`.

**MongoDB document model (graded scope):** the examined catalog lives in **`productdetails`** (`ProductDetail`: `productId`, `longDescription`, `specs` as a `Map`, `gallery[]`, …) and **`reviews`** (`Review`: `productId`, `userId`, `rating`, `title`, `body`, moderation `status`, nested `moderationHistory[]`). Supporting indexes include **`{ status: 1, productId: 1 }`** for the average-rating aggregation prefix match and **`{ productId: 1, status: 1, createdAt: -1 }`** for newest-first “latest reviews” reads. **`wishlists`** is an **additional** collection exercised through the **native driver** (requirement 5 demo); it demonstrates `$push`/`$inc`/`$set`/`$pull` and the compound + text indexes — **it does not replace** the graded product-detail + review document design above.

## 📜 Business Rules

Every rule below is enforced by the database layer **and** the REST API. The table maps each rule to the file that implements it.

| # | Business rule | How it is enforced | Where in code |
|---|---|---|---|
| BR1 | **Price change does not modify historical `order_lines`.** Snapshot of unit price taken at checkout. | `OrderLine.price` is a `Decimal` column populated from `items[].price` during the Prisma checkout transaction. `PATCH /api/products/:id/price` updates only `products.price` — it deliberately never touches `OrderLine`. | `prisma/schema.prisma` (`OrderLine.price`), `inventory-order-service/src/index.js` (`POST /checkout`, `PATCH /products/:id/price`) |
| BR2 | **Cancelling an order restores stock.** Audit-logged as a separate `inventory_movements` row. | `POST /api/orders/:id/cancel` runs a Prisma transaction that flips `Order.status='CANCELLED'`, executes `UPDATE variants SET stock = stock + line.quantity` for every line, inserts a compensating `inventory_movements` row with `reason='order_cancel_restore'`, and re-rolls `products.stock`. | `inventory-order-service/src/index.js` (`POST /orders/:id/cancel`) |
| BR3 | **SKU is globally unique** at both product and variant grain. | `products.sku` has `UNIQUE` (Knex migration 0001). `variants.sku` has `.notNullable().unique()` (Knex migration `create_variants_and_inventory_movements`). PG `SQLSTATE 23505` is mapped to `409 conflict_unique_violation` by the pg error middleware. | `migrations/20260425210152_create_products.js`, `migrations/20260515140000_create_variants_and_inventory_movements.js`, `inventory-order-service/src/middleware/errorMiddleware.js` |
| BR4 | **Cart / checkout conflict when stock is depleted.** Returns `409` with a domain code. | `POST /api/cart/:userId/add` performs an explicit stock check before insert and returns `409 insufficient_stock` with `{ available, requested }`. `POST /api/checkout` row-locks variants via `SELECT … FOR UPDATE` and aborts with `409 conflict_oversell` when any line exceeds available stock. | `inventory-order-service/src/index.js` (`POST /cart/:userId/add`, `POST /checkout`) |
| BR5 | **Unified error contract.** Every failure crosses the wire as the same envelope. | `{ error: string, code: number, details: any }` returned by all three services. PG codes (`23505`, `23503`) and Mongo codes (`11000`, `ValidationError`, `CastError`) are mapped to HTTP + a stable domain string by middleware — no raw driver objects ever leave the process. | `api-gateway/src/index.js` (`sendError`), `inventory-order-service/src/middleware/errorMiddleware.js`, `catalog-analytics-service/src/middleware/mongoErrorMiddleware.js` |


## 🔁 Hybrid Architecture
The system performs two cross-store writes that go through the **Saga Pattern** with compensation. The gateway orchestrates both - there is no shared transaction manager between PG and Mongo.

| # | Hybrid flow | Forward path | Compensation on failure |
|---|---|---|---|
| H1 | **Product creation** (`POST /api/products`) | Insert `products` row (PG) → insert `variants` rows (PG) → insert `productdetails` document (Mongo) | If the Mongo step fails, `DELETE` the PG row (variants cascade). `X-Rollback-Status: success/failed` |
| H2 | **Review moderation** (`POST /api/reviews/:reviewId/moderate`) | Apply decision in Mongo (`Review.status` + `moderationHistory` append) → update the denormalized `products.review_count` counter in PG | If the PG step fails, revert the moderation in Mongo (approve → reject and vice versa). `X-Rollback-Status: success/failed` |

Both responses are always shaped as the unified `{ error, code, details }` envelope; the rollback outcome travels in the `X-Rollback-Status` header so the body contract stays strict.

## 🛡️ Security & Threat Mitigation

The backend implements a defense-in-depth approach. The table below maps concrete threats to the layer that mitigates them.

| # | Threat (OWASP / CWE) | Mitigation in this project | File |
|---|---|---|---|
| T1 | **SQL injection** (CWE-89) | All PG calls use parameterized queries (`$1, $2`). Knex query builder binds values, never concatenates strings. Numeric query params are coerced and validated before they reach SQL. | `pg-service/src/index.js`, `pg-service/src/db/pg.js` |
| T2 | **NoSQL injection** (CWE-943) | All write paths go through Mongoose schemas with explicit types + custom validators. The native driver receives only objects assembled server-side. | `mongo-service/src/models/*.js`, `mongo-service/src/db/mongoClient.js` |
| T3 | **Malformed input / bad types** (CWE-20) | Every public POST/PUT on the gateway runs through a Zod schema before hitting the saga. Invalid input → 400 `validation_error`. | `api-gateway/src/validators.js` |
| T4 | **Stack trace / error info leak** (CWE-209) | Global Express error handlers in **all three services** return the unified `{ error, code, details }` envelope. `err.stack` is logged server-side only. | `pgErrorMap`, `mongoErrorMap`, gateway global handler |
| T5 | **Unique constraint exposure** (CWE-209) | Postgres `SQLSTATE 23505` is mapped to `409 conflict_unique_violation`; FK violation `23503` → `400 foreign_key_violation`. No raw `pg` error object is forwarded. | `pg-service/src/middleware/errorMiddleware.js` |
| T6 | **Mongoose / Mongo error exposure** | `ValidationError` → 400, `CastError` → 400, duplicate key (11000) → 409, network errors → 503. The client never sees `err.errInfo` or driver internals. | `mongo-service/src/middleware/mongoErrorMiddleware.js` |
| T7 | **Race condition / oversell** (CWE-362) | `SELECT … FOR UPDATE` locks **`variants`** rows inside a Prisma interactive checkout transaction so concurrent purchases serialize on SKU-level stock. | `pg-service/src/index.js` (`POST /checkout`) |
| T8 | **Distributed state corruption** (CWE-460) | Saga Pattern. Failures in step 2 trigger compensating `DELETE` in step 1. Outcome is exposed via `X-Rollback-Status` response header. | `api-gateway/src/index.js` (`POST /api/products`) |
| T9 | **Unhandled rejection / container crash** | `process.on('unhandledRejection', ...)` keeps the container alive and logs the reason instead of letting Node abort. | `pg-service/src/index.js` |

### Verifying the mitigations

Run the `14. security` folder in the Postman collection — it covers T1, T3, T4, T5 and T6 with a live request and asserts the unified envelope every time.


## 🧪 Automated Testing

### Postman collection (recommended)

A full Postman collection is bundled at [`tests/postman/BD2-backend.postman_collection.json`](tests/postman/BD2-backend.postman_collection.json). Import it into Postman and run the folders in order.

Helpers in [`tests/`](tests/):
- `setup.ps1` – clean rebuild + wait for healthy + show seeded products.
- `containerization.ps1` – sanity checks for multi-stage Dockerfiles, healthchecks, depends_on, .env.example, auto-seeder.
- `microservices.ps1` – sanity checks for separate Node containers, DB split, HTTP discovery, migrations from compose.

### E2E / integration suite (supertest + isolated stack)

`backend/api-gateway/src/e2e.test.js` uses `supertest` and is wired to `jest` with `--runInBand` for deterministic ordering. GitHub Actions (`.github/workflows/e2e-tests.yml`) spins up an isolated docker compose stack (`postgres`, `mongodb`, all microservices) on every push and pull request, runs migrations + seeds, then executes the suite.

| # | Critical path | What it asserts |
|---|---|---|
| 0 | `/health` smoke | Gateway is reachable |
| 1 | Initial product list | Aggregated PG + Mongo list works, snapshots stock |
| 2 | Oversell protection | `quantity > stock` → 409 with unified envelope |
| 3 | Successful checkout | 201 + `success: true` + `orderId` returned |
| 4 | Stock reduction | Stock decreased by exactly the purchased quantity |
| 5 | Cancel + stock restore | `POST /orders/:id/cancel` restores stock to original |
| 6 | Single product aggregation | `GET /products/:id` merges PG (base) with Mongo (variants, gallery) |
| 7 | Hybrid saga happy path | `POST /products` writes to both DBs and returns 201 |
| 8 | Hybrid saga compensation | Mongo validator failure → PG row rolled back → `X-Rollback-Status: success` |
| 9 | Zod validation rejection | Empty `name` + negative `price` → 400 `validation_error` |
| 10 | Cart sync round trip | `POST /cart/:userId/sync` persists, `GET /cart/:userId` returns content |
| 11 | Empty cart default | Unknown user → 200 with `{ lines: [], totalPrice: 0 }` |

Run locally:
```bash
docker exec -it spa-api-gateway-1 npm run test:e2e
```

Run the same critical paths against a local stack from Postman: open the `13. automated tests (critical paths)` folder in the bundled collection — every step there mirrors a supertest case and can be executed against an already-running stack.



# 💻 Part 2: Frontend Client (SPA)

A modern Single Page Application built with **React and Vite**, serving as the storefront for the backend infrastructure. It features a complete customer storefront and an admin management panel.


## 🛍️ Customer Features

- **Product Catalog**
  - Browse 18+ premium jewellery products across 4 categories (Rings, Necklaces, Earrings, Bracelets)
  - Advanced filtering by category, price range, rating, and search keywords
  - Product variants with color and size options
  - Detailed product pages
  - Related product recommendations
  - URL-synced filters and pagination for shareable links

- **Shopping Experience**
  - Intuitive shopping cart with variant and size tracking
  - Cart persistence using LocalStorage
  - Promo code system (use `AURA20` for 20% discount)
  - Real-time price calculations

- **Checkout Process**
  - Multi-step checkout wizard (4 steps)
  - Personal details collection with validation
  - Shipping method selection (Standard $5 / Express $15)
  - Payment information capture
  - Order summary and confirmation
  - Order history in user profile

- **User Authentication**
  - Registration and login system
  - User profile management
  - Order history tracking
  - Protected routes for authenticated users

## 🛠️ Admin Features

- **Analytics Dashboard**
  - Key metrics overview (total orders, revenue, active products)
  - Sales by category visualization (bar chart)
  - Revenue over time tracking
  - Order management with date range filtering
  - Order deletion capabilities

- **Product Management**
  - Full CRUD operations for products
  - Variant management (colors, sizes, images, price adjustments)
  - Complex product form with comprehensive validation
  - Pagination (10 products per page)
  - Factory reset to restore default data

- **Development Tools**
  - Role switcher for testing different user perspectives

## ⚙️ Tech Stack (Frontend)

- **Framework:** React 18.3.1, React Router DOM 7.1.1, Vite 6.0.5  
- **Styling:** SASS  
- **Form Management:** Formik, Yup, React Hook Form  
- **UI Libraries:** React Hot Toast, Lucide React, Recharts  

## 💻 Frontend Installation & Usage
If running outside of Docker Compose, you can start the frontend independently:
```
cd frontend
npm install
npm run dev
```

Navigate to ```http://localhost:5173```

## 🧭 Routing Structure

### Client Routes
- `/` - Home page with hero section and categories
- `/products` - Product list with filtering
- `/products/:id/:variantId` - Product details
- `/cart` - Shopping cart
- `/checkout` - Multi-step checkout
- `/order-confirmation/:id` - Order success page
- `/account` - Login/Register/Profile

### Admin Routes
- `/admin` - Redirects to dashboard
- `/admin/dashboard` - Analytics dashboard
- `/admin/products` - Product management interface


## ⚠️ Disclaimer

This project is created strictly for **educational purposes** to demonstrate technical skills in React and SPA development. It is **not** intended for commercial use.

The visual identity, product imagery, and descriptions are sourced from and inspired by **[Steff Eleoff](https://steffeleoff.com)**. I do not claim ownership of these assets; all intellectual property rights belong to their respective owners.