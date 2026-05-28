# stage 1: build the vite production bundle
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# emits a static dist/ directory ready to be served by nginx
RUN npm run build

# stage 2: serve via nginx-unprivileged image which already runs as a non-root user
# this satisfies kubernetes securityContext.runAsNonRoot=true without extra Dockerfile changes
FROM nginxinc/nginx-unprivileged:alpine

# copy our custom server config (listens on 8080, adds a /health endpoint)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# copy the built spa into the document root served by nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx-unprivileged listens on 8080 by default (not 80)
EXPOSE 8080
