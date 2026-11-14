# Debian (glibc), not Alpine: onnxruntime-node - the face check's inference
# runtime - ships glibc binaries only.

# Face-check model weights. Its own stage, keyed on the manifest alone, so the
# ~40 MB download is cached across deploys and only repeats when a pinned
# model changes. The script verifies every file's SHA-256.
FROM node:22-bookworm-slim AS models
WORKDIR /app
COPY face-models.json ./
COPY scripts/download-face-models.mjs ./scripts/
RUN node scripts/download-face-models.mjs

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
# onnxruntime-node would otherwise download its CUDA build; there is no GPU.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --config.dangerously-allow-all-builds=true

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# uid 100 / gid 101 on purpose: the ids the Alpine image's `app` user had.
# The bind-mounted mailserver account file is owned by them on the host, and
# the staff-mailbox console has to keep writing it. (-o: Debian already uses
# uid 100 for _apt, which never runs in this container.)
RUN groupadd -o --gid 101 app \
 && useradd -o --uid 100 --gid 101 --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/migrations ./dist/src/database/migrations
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# The face engine checks ./models against ./face-models.json at startup.
COPY --from=models /app/models ./models
COPY --from=build /app/face-models.json ./face-models.json
USER app
EXPOSE 3000
CMD ["node", "dist/src/main"]
