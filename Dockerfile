FROM node:21-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# ---------------------------------------------------------------------------

FROM node:21-alpine

WORKDIR /app

# Copy built dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/config ./config
COPY --from=builder /app/package.json ./

# Create cache directories
RUN mkdir -p /app/cache/images /app/cache/temp

ENV NODE_ENV=production
ENV PORT=11436

EXPOSE 11436

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:11436/health || exit 1

CMD ["node", "server/index.js"]
