# syntax=docker/dockerfile:1

# Reproducible inputs: pin the bun toolchain version explicitly.
ARG BUN_VERSION=1.2.15

# Pinned bun toolchain from the official image — the correct musl/arch binary.
# npm's `bun` shim resolves @oven/bun-linux-aarch64 (glibc) and fails on alpine/arm64
# (musl), so we copy bun from oven/bun instead of `npm install -g bun`.
# ponytail: base pinned by tag only; upgrade path = append @sha256:<digest>.
FROM oven/bun:${BUN_VERSION}-alpine AS bun

# Stage 1: install deps (mirror the reference app's bun-on-alpine pattern).
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

# Lockdown: nothing in this pod must be executable except nginx itself, so a
# `kubectl exec` (e.g. a leaked kubeconfig) cannot drop a shell, exfiltrate via
# curl/wget, or read the env. The config is STATIC (nginx.conf is COPYd above) so
# we don't need nginx's /docker-entrypoint.sh envsubst templating — run nginx
# directly, bypassing the sh-based entrypoint, then delete every interpreter.
#
# alpine's /bin/sh, /bin/ash, wget, nc, printenv, env are all busybox symlinks, so
# removing /bin/busybox kills the lot; curl is a SEPARATE real binary (apk pkg) +
# its own libs. This is the LAST step on purpose: every command above this line
# still has a shell to run in. ponytail: if a future build step needs a shell,
# split it into an earlier RUN — this rm must stay last.
# ref. architecture/0004 (static-server) + the deploy hardening in architecture/0013.
# Briefly back to root: the base image already dropped to uid 101, which can't
# unlink root-owned binaries. We drop straight back to 101 right after.
USER root
# Single rm -rf invocation: it reads ALL its args (and forks busybox) before it
# unlinks anything, so deleting /bin/busybox in the same call is safe. The trailing
# `[ … ]` is the shell's `test` BUILTIN (no fork), so it still runs after busybox
# is gone — re-asserting the hole is closed, else failing the build.
RUN rm -rf /docker-entrypoint.sh /docker-entrypoint.d /usr/bin/curl \
           /bin/busybox /bin/sh /bin/ash \
           /usr/bin/wget /usr/bin/nc /usr/bin/printenv /usr/bin/env \
           /lib/libcurl.so.* /usr/lib/libcurl.so.* ; \
    if [ -e /bin/busybox ] || [ -e /bin/sh ] || [ -e /usr/bin/curl ] || [ -e /usr/bin/wget ]; then exit 1; fi

# Image already drops to the non-root `nginx` user (uid 101).
USER 101
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]
