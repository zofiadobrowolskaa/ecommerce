# stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# install dependencies
RUN npm install
COPY . .

# stage 2: production
FROM node:20-alpine
WORKDIR /app
# copy only the files required at runtime
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# create dedicated unprivileged user and reassign ownership of the app directory
# required by kubernetes securityContext.runAsNonRoot=true
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app

# drop root privileges before the container starts
USER app

EXPOSE 3002
# start the service
CMD ["npm", "start"]
