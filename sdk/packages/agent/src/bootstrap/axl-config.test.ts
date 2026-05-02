import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_AXL_API_HOST,
  DEFAULT_AXL_API_PORT,
  DEFAULT_AXL_CONFIG_PATH,
  DEFAULT_AXL_PEER_KEY,
  DEFAULT_AXL_TCP_PORT,
  writeAxlConfig,
} from "./axl-config.js";

describe("AXL config defaults", () => {
  test("expose canonical port + host constants", () => {
    expect(DEFAULT_AXL_API_PORT).toBe(9002);
    expect(DEFAULT_AXL_TCP_PORT).toBe(9201);
    expect(DEFAULT_AXL_API_HOST).toBe("127.0.0.1");
    expect(DEFAULT_AXL_PEER_KEY).toBe("./private.pem");
    expect(DEFAULT_AXL_CONFIG_PATH).toBe("./node-config.json");
  });
});

describe("writeAxlConfig", () => {
  const tmp = join(tmpdir(), `acl-axl-config-${Date.now()}-${Math.random()}`);
  const cfgPath = join(tmp, "node-config.json");

  beforeAll(() => {});

  afterAll(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("creates parent directory and writes round-trippable JSON", () => {
    writeAxlConfig(cfgPath, {
      PrivateKeyPath: "/abs/private.pem",
      Peers: ["tls://127.0.0.1:9202"],
      Listen: ["tls://0.0.0.0:9201"],
      api_port: 9002,
      tcp_port: 9201,
      bridge_addr: "127.0.0.1",
    });
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed).toMatchObject({
      PrivateKeyPath: "/abs/private.pem",
      Peers: ["tls://127.0.0.1:9202"],
      api_port: 9002,
      tcp_port: 9201,
      bridge_addr: "127.0.0.1",
    });
  });

  test("preserves PascalCase / snake_case mix exactly (AXL parses both)", () => {
    writeAxlConfig(cfgPath, {
      PrivateKeyPath: "/abs/private.pem",
      Peers: [],
      Listen: ["tls://0.0.0.0:9201"],
      api_port: 9002,
      tcp_port: 9201,
      bridge_addr: "127.0.0.1",
    });
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain('"PrivateKeyPath"');
    expect(text).toContain('"Peers"');
    expect(text).toContain('"Listen"');
    expect(text).toContain('"api_port"');
    expect(text).toContain('"tcp_port"');
    expect(text).toContain('"bridge_addr"');
  });
});
