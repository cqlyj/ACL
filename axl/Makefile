SHELL := /bin/bash
AXL_REPO := https://github.com/gensyn-ai/axl.git
AXL_DIR  := axl-src
NODE_BIN := node

.PHONY: all clone build clean keys setup start-a start-b stop smoke-test

all: setup

# Clone the AXL repo (shallow, no history)
clone:
	@if [ ! -d "$(AXL_DIR)" ]; then \
		echo "Cloning AXL repository..."; \
		git clone --depth 1 $(AXL_REPO) $(AXL_DIR); \
	else \
		echo "AXL source already cloned"; \
	fi

# Build the node binary, then drop the entire upstream source tree.
# After `make setup` succeeds, the axl/ folder only contains:
#   configs/  keys/  scripts/  .gitignore  Makefile  node (binary)
build: clone
	@echo "Building AXL node binary..."
	cd $(AXL_DIR) && go build -o ../$(NODE_BIN) ./cmd/node/
	@echo "AXL node binary built: $(NODE_BIN)"
	@echo "Removing upstream source tree ($(AXL_DIR))..."
	@rm -rf $(AXL_DIR)

# Generate ed25519 keys for two test nodes
keys:
	@mkdir -p keys
	@echo "Generating ed25519 keys..."
	@openssl genpkey -algorithm ed25519 -out keys/node-a.pem 2>/dev/null
	@openssl genpkey -algorithm ed25519 -out keys/node-b.pem 2>/dev/null
	@echo "Keys generated in keys/"

# Full setup: clone, build, generate keys
setup: build keys
	@echo ""
	@echo "AXL setup complete."
	@echo "  Binary:  ./$(NODE_BIN)"
	@echo "  Keys:    keys/node-a.pem, keys/node-b.pem"
	@echo "  Configs: configs/node-a.json, configs/node-b.json"
	@echo ""
	@echo "Run 'make start-a' and 'make start-b' in separate terminals."

# Start node A (client side)
start-a:
	@echo "Starting AXL Node A (client) on port 9002..."
	./$(NODE_BIN) -config configs/node-a.json

# Start node B (provider side)
start-b:
	@echo "Starting AXL Node B (provider) on port 9012..."
	./$(NODE_BIN) -config configs/node-b.json

# Stop both nodes
stop:
	@echo "Stopping AXL nodes..."
	@-pkill -f "$(NODE_BIN) -config configs/node-a.json" 2>/dev/null || true
	@-pkill -f "$(NODE_BIN) -config configs/node-b.json" 2>/dev/null || true
	@echo "Nodes stopped."

# Run smoke test
smoke-test:
	@bash scripts/smoke-test.sh

# Clean everything
clean:
	rm -rf $(AXL_DIR) $(NODE_BIN)
	rm -f keys/*.pem
