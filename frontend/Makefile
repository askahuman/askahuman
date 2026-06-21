.PHONY: install dev build preview lint test interop

install: ## install deps (bun)
	bun install

dev: ## astro dev server
	bun run dev

build: ## static build -> dist/
	bun run build

preview: ## preview the built dist/
	bun run preview

lint: ## type-check + astro diagnostics
	bun run check

test: ## unit tests (vitest)
	bun run test

interop: ## Go<->JS SPAKE2 + secretbox interop check (needs ../backend Go toolchain)
	node test/spake2-interop.mjs
