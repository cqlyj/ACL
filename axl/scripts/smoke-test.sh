#!/usr/bin/env bash
set -euo pipefail

# AXL smoke test: verifies two local nodes can exchange messages
# Prerequisites: both nodes must be running (make start-a / make start-b)

NODE_A_API="http://127.0.0.1:9002"
NODE_B_API="http://127.0.0.1:9012"

echo "=== ACL / AXL Smoke Test ==="
echo ""

# 1. Check both nodes are running
echo "[1/5] Checking Node A topology..."
TOPO_A=$(curl -sf "$NODE_A_API/topology" 2>/dev/null) || { echo "FAIL: Node A not responding on $NODE_A_API"; exit 1; }
KEY_A=$(echo "$TOPO_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
echo "  Node A public key: $KEY_A"

echo "[2/5] Checking Node B topology..."
TOPO_B=$(curl -sf "$NODE_B_API/topology" 2>/dev/null) || { echo "FAIL: Node B not responding on $NODE_B_API"; exit 1; }
KEY_B=$(echo "$TOPO_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
echo "  Node B public key: $KEY_B"

# 2. Send HELLO from Node B (provider) to Node A (client)
echo "[3/5] Sending HELLO from Node B → Node A..."
MSG='{
  "protocol": "acl.axl.v1",
  "type": "HELLO",
  "id": "smoke-test-001",
  "replyTo": null,
  "createdAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
  "payload": { "message": "hello from provider" }
}'

curl -sf -X POST "$NODE_B_API/send" \
  -H "X-Destination-Peer-Id: $KEY_A" \
  -H "Content-Type: application/json" \
  -d "$MSG" > /dev/null 2>&1 || { echo "FAIL: Could not send from B to A"; exit 1; }
echo "  Sent."

# 3. Receive on Node A
echo "[4/5] Receiving on Node A..."
sleep 2
RESPONSE=$(curl -sf "$NODE_A_API/recv" 2>/dev/null) || { echo "FAIL: No message received on Node A"; exit 1; }
echo "  Received: $RESPONSE"

# 4. Send a PROPOSE envelope from Node A (client) to Node B (provider).
#    The SDK uses an 8-message taxonomy
#    (HELLO/PROPOSE/COUNTER/ACCEPT/REJECT/CANCEL/ACK/ERROR); this smoke-test
#    only exercises bridge transport so we ship a minimal hand-rolled
#    PROPOSE shaped like @acl/negotiation does.
echo "[5/5] Sending PROPOSE from Node A → Node B..."
PROPOSE='{
  "protocol": "acl.axl.v1",
  "type": "PROPOSE",
  "id": "smoke-test-002",
  "replyTo": null,
  "createdAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
  "payload": {
    "taskSpec": {
      "title": "Smoke-test task",
      "objective": "Summarize the latest research on quantum computing",
      "acceptanceCriteria": ["Concise"],
      "requiredFormat": "text",
      "deliveryType": "text",
      "taskDomain": "research",
      "createdAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    },
    "proposal": {
      "client": "0x1234567890abcdef1234567890abcdef12345678",
      "provider": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "evaluator": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "paymentToken": "0x05B97e7E40BE8B04AE0F337C0Aefdd88eFe8fe20",
      "amount": "1000000",
      "hook": "0xdaD0980a4BA091CE5F8446FD3ca67ffC4b7966D6",
      "taskSpecHash": "0x0000000000000000000000000000000000000000000000000000000000000001",
      "expiresAt": "1900000000",
      "nonce": "0x0000000000000000000000000000000000000000000000000000000000000003"
    }
  }
}'

curl -sf -X POST "$NODE_A_API/send" \
  -H "X-Destination-Peer-Id: $KEY_B" \
  -H "Content-Type: application/json" \
  -d "$PROPOSE" > /dev/null 2>&1 || { echo "FAIL: Could not send PROPOSE from A to B"; exit 1; }

sleep 2
RECV_B=$(curl -sf "$NODE_B_API/recv" 2>/dev/null) || { echo "FAIL: No PROPOSE received on Node B"; exit 1; }
echo "  Provider received: $RECV_B"

echo ""
echo "=== Smoke test PASSED ==="
echo "Node A (client):   $KEY_A"
echo "Node B (provider): $KEY_B"
