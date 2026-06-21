# syntax=docker/dockerfile:1

# Reproducible inputs: pin the bun toolchain version explicitly.
ARG BUN_VERSION=1.2.15

# Pinned bun toolchain from the official image — the correct musl/arch binary.
# npm's `bun` shim resolves @oven/bun-linux-aarch64 (glibc) and fails on alpine/arm64
# (musl), so we copy bun from oven/bun instead of `npm install -g bun`.
# ponytail: base pinned by tag only; upgrade path = append @sha256:<digest>.
FROM oven/bun:${BUN_VERSION}-alpine AS bun

# Stage 1: install deps (mirror platia's bun-on-alpine pattern).
# ponytail: base pinned by tag only; upgrade path = append @sha256:<digest>
# (e.g. `docker buildx imagetools inspect node:22-alpine`) for a fully reproducible build.
FROM node:22-alpine AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Stage 2: build the static PWA -> dist/.
# ponytail: base pinned by tag only; upgrade path = append @sha256:<digest>.
FROM node:22-alpine AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Narrow COPY: only the sources the build needs (.dockerignore is the second guard).
COPY package.json bun.lock tsconfig.json astro.config.mjs ./
COPY src ./src
COPY public ./public
RUN bun run build

# Stage 3: serve dist/ as static files.
# nginx-unprivileged: tiny, no Node runtime / no node_modules in the final image,
# runs as non-root (uid 101) out of the box, listens on 8080. The PWA is content-blind
# static assets, so a plain static server is the correct minimum (architecture/0004).
# ponytail: base pinned by tag only; upgrade path = append @sha256:<digest>.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
# Image already drops to the non-root `nginx` user (uid 101).
USER 101
