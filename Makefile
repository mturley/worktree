BINARY_NAME := worktree
BIN_DIR := bin
INSTALL_DIR := /usr/local/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -ldflags "-X github.com/mturley/worktree/cmd.Version=$(VERSION)"

.PHONY: build install test clean

build:
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
	@echo "Installed $(INSTALL_DIR)/$(BINARY_NAME)"
	@$(INSTALL_DIR)/$(BINARY_NAME) setup $(if $(NONINTERACTIVE),--yes,)

test:
	go test ./... -v

clean:
	rm -rf $(BIN_DIR)
