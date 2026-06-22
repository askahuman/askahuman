.PHONY: up down ci-up e2e https pair \
	backend-build backend-lint backend-test \
	frontend-install frontend-build frontend-lint \
	help

CLUSTER_FILE := infra/local/cluster.yaml

# Homebrew tools (tilt/ko/ctlptl/kubectl) live here on Apple Silicon; ensure they resolve.
export PATH := /opt/homebrew/bin:$(PATH)

# Local dev cluster + Tilt loop (architecture/0003).
up: ## Provision the kind cluster + registry, then start Tilt (interactive UI)
	ctlptl apply -f $(CLUSTER_FILE)
	tilt up

down: ## Stop Tilt and tear down the kind cluster + registry
	-tilt down
	ctlptl delete -f $(CLUSTER_FILE)

ci-up: ## Headless bring-up: provision the cluster, build + apply, wait for healthy (no UI)
	ctlptl apply -f $(CLUSTER_FILE)
	tilt ci

e2e: ## Live end-to-end check against the running kind system (needs `make ci-up` first)
	./scripts/e2e.sh

https: ## Local HTTPS proxy (mkcert) so the iPhone service worker + push work
	./scripts/https-lan.sh

pair: ## Pair a phone over the LAN + send one demo request (HTTPS=1 make pair uses the TLS proxy)
	./scripts/pair-lan.sh

# Backend (delegated to backend/Makefile).
backend-build: ## Build the relay + MCP agent binaries
	$(MAKE) -C backend build

backend-lint: ## Lint the Go backend
	$(MAKE) -C backend lint

backend-test: ## Run backend tests
	$(MAKE) -C backend test

# Frontend (delegated to frontend/Makefile).
frontend-install: ## Install frontend deps
	$(MAKE) -C frontend install

frontend-build: ## Build the static PWA bundle
	$(MAKE) -C frontend build

frontend-lint: ## Lint the frontend
	$(MAKE) -C frontend lint

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
