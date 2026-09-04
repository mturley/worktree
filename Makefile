BINARY_NAME := worktree
BIN_DIR := bin
INSTALL_DIR := /usr/local/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -ldflags "-X github.com/mturley/worktree/cmd.Version=$(VERSION)"

.PHONY: build build-web build-cli install stop-running test test-web clean clean-web dev

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

# pgrep -f finds candidates by command line, but a candidate's argv could name a
# different binary (a script arg, a same-named tool elsewhere on PATH). Confirm
# each PID's actual executable (lsof txt fd) is the exact file we're replacing
# before killing it, so we never signal an unrelated process.
stop-running:
	@target_dir=$$(cd "$(INSTALL_DIR)" 2>/dev/null && pwd -P) || target_dir="$(INSTALL_DIR)"; \
	target="$$target_dir/$(BINARY_NAME)"; \
	pattern="(^|/)$(BINARY_NAME) ($$(echo '$(SERVER_CMDS)' | tr ' ' '|'))($$| )"; \
	confirm() { \
		out=""; \
		for pid in $$1; do \
			exe=$$(lsof -a -p "$$pid" -d txt -Fn 2>/dev/null | awk '/^n/{print substr($$0,2); exit}'); \
			if [ "$$exe" = "$$target" ]; then out="$$out $$pid"; fi; \
		done; \
		echo $$out; \
	}; \
	pids=$$(confirm "$$(pgrep -f "$$pattern" 2>/dev/null || true)"); \
	if [ -n "$$pids" ]; then \
		echo "Stopping running $(BINARY_NAME) server(s) [$$target]:$$pids"; \
		kill -TERM $$pids 2>/dev/null || true; \
		sleep 2; \
		pids=$$(confirm "$$(pgrep -f "$$pattern" 2>/dev/null || true)"); \
		if [ -n "$$pids" ]; then \
			echo "Force-killing remaining $(BINARY_NAME) server(s):$$pids"; \
			kill -KILL $$pids 2>/dev/null || true; \
		fi; \
	fi

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

test:
	go test ./... -v
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
