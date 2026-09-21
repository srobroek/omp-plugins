# Go recipes, imported by the root justfile.

# Format, lint, and test
[group('go')]
go: go-fmt go-lint go-test

# Format
[group('go')]
go-fmt:
    gofmt -w .

# Lint. gosec and revive are enabled in .golangci.yml, not passed here
[group('go')]
go-lint:
    golangci-lint run ./...

# Test, with the race detector
[group('go')]
go-test:
    go test -race ./...

# Known vulnerabilities in the dependency graph
[group('go')]
go-vuln:
    govulncheck ./...

# Fail when go.mod or go.sum is not tidy
[group('go')]
go-tidy-check:
    go mod tidy -diff

# Coverage
[group('go')]
go-cov:
    go test -race -coverprofile=coverage.out -covermode=atomic ./...
    go tool cover -func=coverage.out | tail -1

# Downloads into the shared module cache rather than the tree, so a warm run is 15ms.

# Download the locked module dependencies
[group('go')]
go-install:
    go mod download
