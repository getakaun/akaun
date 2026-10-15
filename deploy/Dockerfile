FROM oven/bun:1.2-alpine AS base
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json bun.lock ./

FROM base AS prod-deps
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile

FROM base AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
# The version the UI shows. .git is dockerignored and this image has no git binary, so the
# value has to be passed in; CI computes `git describe` on the runner. Declared here rather
# than at the top so the bun install layers above stay cached when only the version changes.
ARG APP_VERSION=unknown
ENV AKAUN_VERSION=$APP_VERSION
RUN bun run build

FROM oven/bun:1.2-alpine AS runtime
RUN apk add --no-cache su-exec tzdata
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/build       ./build
COPY --from=builder   /app/drizzle     ./drizzle
COPY --from=builder   /app/package.json ./package.json
COPY server.js ./server.js
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV TZ=Etc/UTC
ENV NODE_ENV=production
ENV PORT=6969
ENV DATABASE_PATH=/app/data/akaun.db
ENV STORAGE_PATH=/app/data/storage
ENV LOG_LEVEL=info
ENV BODY_SIZE_LIMIT=21M
ENV SSL_ENABLED=false
EXPOSE 6969
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c 'wget -qO /dev/null --no-check-certificate "http$( [ "$SSL_ENABLED" = true ] && echo s )://localhost:${PORT}/health"'
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "server.js"]
