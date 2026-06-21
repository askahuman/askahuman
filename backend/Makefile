.PHONY: lint lint-fix fmt test vulncheck build help

# Lint-check the code
lint:
	golangci-lint run --timeout 5m --config=.golangci.yaml

# Fix linting issues automatically (imports, formatting, then auto-fixable lints)
lint-fix:
	ls -d */ | grep -v vendor | xargs -tIX -P 0 gci write --skip-generated -s standard -s default -s "prefix(github.com/askahuman)" X
	gofumpt -w .
	golangci-lint run --fix --config=.golangci.yaml

# Format the code
fmt:
	gofumpt -w .

# Run all tests
test:
	go test ./...

# Check for vulnerabilities
vulncheck:
	govulncheck ./...

# Build all packages
build:
	go build ./...

# Help target
help:
	@echo "Available targets:"
	@echo "  lint       - Run linting checks"
	@echo "  lint-fix   - Fix imports, formatting, and auto-fixable lints"
	@echo "  fmt        - Format the code with gofumpt"
	@echo "  test       - Run all tests"
	@echo "  vulncheck  - Check for vulnerabilities"
	@echo "  build      - Build all packages"
	@echo "  help       - Show this help message"
