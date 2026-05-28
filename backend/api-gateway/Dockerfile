# stage 1: install dependencies in an isolated builder layer
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
# bundled product seed data, used by the seeder job/service
COPY --from=builder /app/seed-products.js ./
COPY --from=builder /app/products.json ./

# create a dedicated unprivileged user and reassign ownership of the app directory
# required by kubernetes securityContext.runAsNonRoot=true
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app

# drop root privileges before the container starts
USER app

EXPOSE 3000
# default command runs the gateway; the seeder job overrides it
CMD ["npm", "start"]
