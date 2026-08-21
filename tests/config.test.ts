import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getIntervalsHome, loadConfig, resolveCredentials } from "../src/domain/config.js";

test("getIntervalsHome uses INTERVALS_HOME when present", () => {
  const home = getIntervalsHome({ INTERVALS_HOME: "/tmp/pi-intervals-test" });
  assert.equal(home, "/tmp/pi-intervals-test");
});

test("resolveCredentials prefers environment variables over config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "file-key", baseUrl: "https://file.example/" }));
    const config = loadConfig(dir);
    const creds = resolveCredentials(config, { INTERVALS_API_KEY: "env-key", INTERVALS_BASE_URL: "https://env.example/" });
    assert.deepEqual(creds, { apiKey: "env-key", baseUrl: "https://env.example/", source: "env" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
