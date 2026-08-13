BINARY_NAME := worktree
BIN_DIR := bin
INSTALL_DIR := /usr/local/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -ldflags "-X github.com/mturley/worktree/cmd.Version=$(VERSION)"

.PHONY: build build-web build-cli install test clean dev

build: build-web build-cli

build-web:
	@if [ ! -f ui/package.json ]; then echo "Error: ui/package.json not found." && exit 1; fi
	@cd ui && npm install --silent && npm run build
	@echo "Built ui/dist/"

build-cli:
	@mkdir -p $(BIN_DIR)
	go build $(LDFLAGS) -o $(BIN_DIR)/$(BINARY_NAME) .

install: build
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

clean:
	rm -rf $(BIN_DIR)
	rm -rf ui/dist
	@mkdir -p ui/dist
	@touch ui/dist/.gitkeep
	rm -rf ui/node_modules

dev:
	@command -v mprocs >/dev/null 2>&1 || { echo "install mprocs for dev mode, or run 'go run . ui --api-only' and 'cd ui && npm run dev' separately"; exit 1; }
	@mprocs "go run . ui --api-only" "cd ui && npm run dev"
