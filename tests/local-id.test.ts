import assert from "node:assert/strict";
import test from "node:test";
import { createShortLocalId, resolveLocalId } from "../src/domain/local-id.js";

test("createShortLocalId returns 8 lowercase hex characters", () => {
  const id = createShortLocalId(() => false);
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("createShortLocalId retries until it finds a free id", () => {
  const ids = ["aaaaaaaa", "bbbbbbbb"];
  let index = 0;
  const id = createShortLocalId(
    (candidate) => candidate === "aaaaaaaa",
    () => ids[index++],
  );
  assert.equal(id, "bbbbbbbb");
});

test("resolveLocalId returns exact matches before prefix matches", () => {
  const resolved = resolveLocalId("abc12345", ["abc12345", "abc12345-0000-0000-0000-000000000000"]);
  assert.equal(resolved, "abc12345");
});

test("resolveLocalId resolves unique 8-character UUID prefix", () => {
  const resolved = resolveLocalId("4ee96f17", ["4ee96f17-0374-4d1b-a92a-05956213a007"]);
  assert.equal(resolved, "4ee96f17-0374-4d1b-a92a-05956213a007");
});

test("resolveLocalId throws for ambiguous 8-character prefixes", () => {
  assert.throws(
    () => resolveLocalId("4ee96f17", [
      "4ee96f17-0374-4d1b-a92a-05956213a007",
      "4ee96f17-aaaa-bbbb-cccc-05956213a007",
    ]),
    /ambiguous/,
  );
});
