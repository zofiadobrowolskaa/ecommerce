# stage 1: build
FROM node:20-alpine AS builder

# install openssl required by the prisma engine
RUN apk add --no-cache openssl

WORKDIR /app
COPY package*.json ./
# install dependencies
RUN npm install
COPY . .

# generate prisma client targeting linux runtime inside the container
RUN npx prisma generate

# stage 2: production
FROM node:20-alpine

# install the openssl library in the final production image
RUN apk add --no-cache openssl

WORKDIR /app

# copy only the files required at runtime from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# copy knex configuration file required for database queries
COPY --from=builder /app/knexfile.js ./

# copy migration and seed folders used by the migrate script / init container
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/seeds ./seeds
COPY --from=builder /app/prisma ./prisma

# create dedicated unprivileged user and reassign ownership of the app directory
# required by kubernetes securityContext.runAsNonRoot=true
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app

# drop root privileges before the container starts
USER app

EXPOSE 3001
# default command starts the http server; the migrate init container overrides with npm run migrate
CMD ["npm", "start"]
