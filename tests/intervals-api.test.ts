import assert from "node:assert/strict";
import test from "node:test";
import { IntervalsApiClient, sanitizeApiError, extractCollection } from "../src/domain/intervals-api.js";

test("api client fetches resource collections with json headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ client: [{ id: 1, name: "Acme" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });
  const clients = await api.listResource("client");
  assert.deepEqual(clients, [{ id: 1, name: "Acme" }]);
  assert.equal(calls[0].url, "https://api.example/client/?limit=100&offset=0");
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "application/json");
  assert.ok((calls[0].init.headers as Record<string, string>).Authorization.startsWith("Basic "));
});

test("api client includes listResource filters with pagination", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ time: [] }), { status: 200 });
  };
  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });

  await api.listResource("time", { personid: "3", datebegin: "2026-04-24", dateend: "2026-04-24" });

  assert.equal(calls[0], "https://api.example/time/?personid=3&datebegin=2026-04-24&dateend=2026-04-24&limit=100&offset=0");
});

test("sanitizeApiError removes secrets", () => {
  assert.equal(sanitizeApiError("Authorization: Basic abc secret-key", "secret-key"), "Authorization: Basic [redacted] [redacted]");
});

test("createResource POSTs body with json content-type", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ time: { id: 42, projectid: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });
  const result = await api.createResource("time", { projectid: 10, time: 1 });
  assert.deepEqual(result, { time: { id: 42, projectid: 10 } });
  assert.equal(calls[0].url, "https://api.example/time/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("updateResource PUTs body with json content-type", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ time: { id: 42, projectid: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });
  const result = await api.updateResource("time", 42, { projectid: 10, time: 2 });
  assert.deepEqual(result, { time: { id: 42, projectid: 10 } });
  assert.equal(calls[0].url, "https://api.example/time/42/");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("deleteResource DELETEs a resource by id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  };
  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });

  await api.deleteResource("time", 42);

  assert.equal(calls[0].url, "https://api.example/time/42/");
  assert.equal(calls[0].init.method, "DELETE");
});

test("extractCollection detects various wrapper keys", () => {
  assert.deepEqual(extractCollection([1, 2], "time"), [1, 2]);
  assert.deepEqual(extractCollection({ time: [{ id: 1 }] }, "time"), [{ id: 1 }]);
  assert.deepEqual(extractCollection({ times: [{ id: 1 }] }, "time"), [{ id: 1 }]);
  assert.deepEqual(extractCollection({ items: [{ id: 1 }] }, "time"), [{ id: 1 }]);
  assert.deepEqual(extractCollection({ data: [{ id: 1 }] }, "time"), [{ id: 1 }]);
  assert.deepEqual(extractCollection({ other: [] }, "time"), []);
});

test("listResource follows limit/offset pagination until the final partial page", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    const limit = Number(parsed.searchParams.get("limit"));
    const offset = Number(parsed.searchParams.get("offset"));

    assert.equal(init?.method, "GET");
    assert.equal(limit, 100);

    const ids = offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
      : offset === 100
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 101 }))
        : offset === 200
          ? [{ id: 201 }]
          : [];

    return new Response(JSON.stringify({ project: ids }), { status: 200 });
  };

  const api = new IntervalsApiClient({ apiKey: "secret", baseUrl: "https://api.example/", fetchImpl });
  const projects = await api.listResource("project");

  assert.equal(projects.length, 201);
  assert.deepEqual(projects.at(0), { id: 1 });
  assert.deepEqual(projects.at(-1), { id: 201 });
  assert.deepEqual(calls, [
    "https://api.example/project/?limit=100&offset=0",
    "https://api.example/project/?limit=100&offset=100",
    "https://api.example/project/?limit=100&offset=200",
  ]);
});
