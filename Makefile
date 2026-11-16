BINARY_NAME := worktree
BIN_DIR := bin
INSTALL_DIR := /usr/local/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -ldflags "-X github.com/mturley/worktree/cmd.Version=$(VERSION)"

.PHONY: build build-web build-cli install stop-running test test-web clean clean-web dev macapp

# Subcommands that run as long-lived servers. If any are running against the
# installed binary when we go to reinstall, they'd keep executing old code, so
# stop-running terminates them before the binary is replaced.
SERVER_CMDS := ui watcher

build: build-web build-cli

# ui/dist is emptied before every build, NOT because the build needs a clean
# slate but because nothing else ever removes what it leaves behind. Vite is
# configured emptyOutDir: false to protect ui/dist/.gitkeep, and it writes
# content-hashed filenames, so each build adds a new set and keeps every older
# one. //go:embed all:ui/dist then bakes all of them into the binary — that is
# how an installed worktree reached 34MB carrying 30 builds' worth of assets
# when the current build accounted for 4 of them.
#
# Deliberately not `clean`: that also removes ui/node_modules, which would put
# a full npm install in front of every build for no benefit.
clean-web:
	@rm -rf ui/dist
	@mkdir -p ui/dist
	@touch ui/dist/.gitkeep

build-web: clean-web
	@if [ ! -f ui/package.json ]; then echo "Error: ui/package.json not found." && exit 1; fi
	@cd ui && npm install --silent && npm run build
	@echo "Built ui/dist/"

build-cli:
	@mkdir -p $(BIN_DIR)
	go build $(LDFLAGS) -o $(BIN_DIR)/$(BINARY_NAME) .

# scripts/stop-running.sh finds the servers by command line, then confirms each
# PID's actual executable (lsof txt fd) is the exact file we're replacing before
# signalling it, so we never touch an unrelated process. A server with a job in
# flight is never killed without asking; NONINTERACTIVE=1 aborts instead.
# STOP_RUNNING_TTY, which redirects that question away from the terminal, is
# the tests' alone: it is cleared here so a stray export cannot answer it.
stop-running: build
	@target_dir=$$(cd "$(INSTALL_DIR)" 2>/dev/null && pwd -P) || target_dir="$(INSTALL_DIR)"; \
	NONINTERACTIVE="$(NONINTERACTIVE)" env -u STOP_RUNNING_TTY sh scripts/stop-running.sh "$$target_dir/$(BINARY_NAME)" "$(BIN_DIR)/$(BINARY_NAME)" $(SERVER_CMDS)

install: build stop-running
	@if [ ! -f $(BIN_DIR)/$(BINARY_NAME) ]; then \
		echo "Error: $(BIN_DIR)/$(BINARY_NAME) not found. Run 'make build' first."; \
		exit 1; \
	fi
	@cp $(BIN_DIR)/$(BINARY_NAME) $(INSTALL_DIR)/.$(BINARY_NAME).tmp
	@chmod 755 $(INSTALL_DIR)/.$(BINARY_NAME).tmp
	@mv $(INSTALL_DIR)/.$(BINARY_NAME).tmp $(INSTALL_DIR)/$(BINARY_NAME)
	@ln -sf $(BINARY_NAME) $(INSTALL_DIR)/wt
	@echo "Installed $(INSTALL_DIR)/$(BINARY_NAME) (also available as wt)"
	@$(INSTALL_DIR)/$(BINARY_NAME) setup $(if $(NONINTERACTIVE),--yes,)

# Builds the macOS menu bar app into bin/ for development, pointed at the
# default port. For a dev server: go run ./internal/macapp/devbuild -url URL.
# `worktree setup` builds the installed copy in ~/Applications. The dev bundle
# shares the installed app's bundle ID and executable name, so setup's
# rebuild and --uninstall-mac-app will also quit a running dev copy.
macapp:
	go run ./internal/macapp/devbuild

test:
	go test ./... -v
	sh scripts/stop-running_test.sh
	$(MAKE) test-web

test-web:
	@cd ui && npm test

clean: clean-web
	rm -rf $(BIN_DIR)
	rm -rf ui/node_modules

dev:
	@command -v mprocs >/dev/null 2>&1 || { echo "Error: mprocs is required for dev mode. Install it: brew install mprocs"; exit 1; }
	@if command -v air >/dev/null 2>&1; then \
		mprocs --names "API: localhost:8475,Frontend: localhost:5175" "air -- ui --api-only" "cd ui && npm run dev"; \
	else \
		echo ""; \
		echo "  air not found — Go API server will not auto-reload on changes."; \
		if [ -x "$$(go env GOPATH)/bin/air" ]; then \
			echo "  air is installed at $$(go env GOPATH)/bin/air but not on PATH."; \
			echo "  Add to your shell rc: export PATH=\"\$$PATH:\$$(go env GOPATH)/bin\""; \
		else \
			echo "  Install it: go install github.com/air-verse/air@latest"; \
			echo "  Then add GOPATH/bin to PATH: export PATH=\"\$$PATH:\$$(go env GOPATH)/bin\""; \
		fi; \
		echo ""; \
		go build -o bin/$(BINARY_NAME) .; \
		mprocs --names "API: localhost:8475,Frontend: localhost:5175" "bin/$(BINARY_NAME) ui --api-only" "cd ui && npm run dev" || true; \
	fi
	@-lsof -ti :8475 2>/dev/null | xargs kill 2>/dev/null || true
