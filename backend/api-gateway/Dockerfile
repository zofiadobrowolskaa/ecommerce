# stage 1: build dependencies in an isolated layer
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# install npm dependencies (uses cache mount semantics on rebuild)
RUN npm install
COPY . .

# stage 2: lean production image without dev artifacts
FROM node:20-alpine
WORKDIR /app
# copy only what is needed to run the gateway at runtime
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
# bundled product seed data, used by the seeder docker compose service
COPY --from=builder /app/seed-products.js ./
COPY --from=builder /app/products.json ./

EXPOSE 3000
# default command runs the gateway; the seeder service overrides it
CMD ["npm", "start"]
