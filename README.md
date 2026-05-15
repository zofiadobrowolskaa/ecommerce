# AURA Jewellery - E-Commerce Platform (Polyglot Microservices)

A comprehensive, feature-rich e-commerce platform for luxury jewellery. The project consists of a modern Single Page Application (React) and a highly robust, microservices-based backend utilizing a Polyglot Persistence architecture (PostgreSQL + MongoDB).

---

# 🏗️ Part 1: Backend Architecture & Database Design

The backend system is designed as a kiosk ordering point. It implements the **Saga Pattern** to maintain consistency between a relational store (PostgreSQL) and a document store (MongoDB).

## 🧩 Microservices Breakdown

| Service | Port | Stack | Responsibility |
|---|---|---|---|
| `api-gateway` | 3000 | Express + Zod + axios + swagger-ui-express | Public entry point. Routing, input validation, distributed saga orchestration, response aggregation, OpenAPI docs, unified error envelope. |
| `pg-service` (Inventory & Order) | 3001 | Express + pg + Knex + Sequelize + Prisma | All ACID data: product catalog (`products`, `categories`), stock with `FOR UPDATE` oversell protection, server-side carts (`Carts`, `CartLines`), orders with price snapshots (`Order`, `OrderLine`). |
| `mongo-service` (Catalog & Analytics) | 3002 | Express + mongodb native + Mongoose | All flexible/document data: extended product details with variants (`ProductDetail`), reviews with moderation history (`Review`), telemetry event log, cart drafts, analytics aggregations. |
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
            PG[("PostgreSQL :5432<br/>products, categories,<br/>Carts, CartLines,<br/>Order, OrderLine")]
            MG[("MongoDB :27017<br/>productdetails, reviews,<br/>event_log, cart_draft")]
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
        G->>MG: POST /internal/product-details (step 2: insert document)
        alt Mongo insert fails (Mongoose validator, duplicate productId, ...)
            MG-->>G: 4xx { error }
            G->>PG: DELETE /internal/products/:id (compensation)
            PG-->>G: 204
            G-->>C: 4xx { error, code, details: { rollbackStatus: "success" } }<br/>+ header X-Rollback-Status: success
        else Mongo insert OK
            MG-->>G: 201
            G-->>C: 201 { id, message: "product created in both databases" }
        end
    end
```

## 🔁 Data Flow — Hybrid Checkout Saga (PG transactional + Mongo telemetry)

```mermaid
sequenceDiagram
    participant C as Client
    participant G as api-gateway
    participant PG as pg-service (Prisma)
    participant MG as mongo-service

    C->>G: POST /api/checkout { userId, items }
    G->>G: Zod validation
    G->>PG: POST /checkout
    PG->>PG: prisma.$transaction (BEGIN)
    PG->>PG: SELECT ... FOR UPDATE (row lock)
    alt Stock < requested
        PG-->>G: 409 conflict_oversell
        G-->>C: 409 unified envelope (no telemetry recorded)
    else Stock OK
        PG->>PG: UPDATE stock; INSERT Order + OrderLines
        PG->>PG: COMMIT
        PG-->>G: 201 { orderId }
        G->>MG: POST /telemetry/event ({ action: "checkout_completed" })<br/>(fire and forget for UX analytics)
        MG-->>G: 201
        G-->>C: 201 { success: true, orderId }
    end
```

The cancel flow (`POST /api/orders/:id/cancel`) is the symmetric inverse: it updates `Order.status = CANCELLED` and restores stock via `tx.$executeRaw` inside another Prisma transaction.

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
1. **`pg` native driver** – Singleton pool, parameterized queries (`$1, $2`), SQLSTATE → HTTP mapping (`23505` → 409, `23503` → 400). Powers inventory stock deductions.
2. **Knex.js** – Schema migrations and domain seeds (categories). Dynamic `WHERE` builder for product catalog filtering (no string concatenation, parameters bound by the builder).
3. **Sequelize v6** – Server-side cart (`Cart`, `CartLine`) with explicit model validators, eager loading via `include`, domain hooks (`beforeValidate`, `afterSave`) and managed transactions.
4. **Prisma ORM** – Order header / order line schema with relations, migration history (`prisma migrate deploy` runs at container start), full CRUD via typed model API, `$queryRaw` tagged templates for `FOR UPDATE` locking and analytics.

**MongoDB side (mongo-service):**

5. **MongoDB native driver** – Singleton `MongoClient`, graceful shutdown on `SIGINT` / `SIGTERM`, telemetry log + cart drafts using 4 distinct operators (`$push`, `$inc`, `$set`, `$pull`). Compound and text indexes.
6. **Mongoose** – `ProductDetail` and `Review` schemas with custom validators (rating must be integer, body must have ≥ 3 words, variants must have unique colors), nested subdocuments (`variants[]`, `gallery[]`, `moderationHistory[]`), pre-save hook, virtual populate, statics (`findByProduct`) and instance methods (`approve()`, `reject()`).
7. **Aggregation Pipeline** – 7-stage analytics report (`$match` → `$group` → `$lookup` → `$unwind` → `$sort` → `$limit` → `$project`). First `$match` is backed by a compound index `{ status, productId }` so the planner uses `IXSCAN` instead of `COLLSCAN`.

## 🛡️ Security & Threat Mitigation

### 1. 🔐 Input Validation
Every incoming request is validated by **Zod** schemas before reaching the gateway business logic, blocking SQL/NoSQL injection vectors. Mongoose adds a second layer of validation (custom validators) for document writes.

### 2. 🚫 Stack Trace Hiding
A global Express error handler returns the unified envelope on any unexpected throw. Stack traces are logged on the server side only.

### 3. 🧾 Explicit Database Error Handling
PostgreSQL `SQLSTATE` codes are mapped to HTTP:
- `23505` (Unique Violation) → `409 Conflict`
- `23503` (Foreign Key Violation) → `400 Bad Request`

### 4. ⚠️ Threat Mitigations
- **Race conditions / overselling:** prevented by row-level locking (`SELECT ... FOR UPDATE`) inside Prisma interactive transactions during checkout.
- **Distributed state inconsistency:** handled by the Saga Pattern. Failures in the second step trigger a compensating action in the first (e.g. `DELETE` in PG after a Mongo write failed). Compensation outcome is reported via the `X-Rollback-Status` response header.

### 5. 🧱 Unified Error Envelope
**Every** failure response across all three services follows the contract `{ error: string, code: number, details: any }`. The client never sees raw exceptions, ORM-specific error shapes, or framework boilerplate.

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