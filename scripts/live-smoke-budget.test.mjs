import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { openLiveSmokeBudget } from "./live-smoke-budget.mjs";

test("counts requests before sending, preserves a grant across runs, and rejects the twenty-first", () => {
  const root = mkdtempSync(join(tmpdir(), "gv-budget-test-"));
  let budget;
  try {
    budget = openLiveSmokeBudget(root, "synthetic-grant");
    assert.equal(budget.used, 0);
    for (let index = 1; index <= 7; index++) assert.equal(budget.reserve(), index);
    assert.throws(() => openLiveSmokeBudget(root, "synthetic-grant"));
    budget.close();
    assert.throws(() => budget.reserve());
    budget = openLiveSmokeBudget(root, "synthetic-grant");
    assert.equal(budget.used, 7);
    for (let index = 8; index <= 20; index++) assert.equal(budget.reserve(), index);
    assert.throws(() => budget.reserve(), /LIVE_SMOKE_REQUEST_LIMIT/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "request-budget.json"), "utf8")),
      { grantId: "synthetic-grant", limit: 20, used: 20 });
    budget.close(); budget = undefined;
    assert.throws(() => openLiveSmokeBudget(root, "different-grant"), /LIVE_SMOKE_BUDGET_INVALID/);
  } finally { budget?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a corrupt existing counter is rejected instead of resetting the paid-call allowance", () => {
  const root = mkdtempSync(join(tmpdir(), "gv-budget-corrupt-test-"));
  try {
    for (const used of [-1, 21, null, "0", 1.5]) {
      writeFileSync(join(root, "request-budget.json"), JSON.stringify({ grantId: "synthetic-grant", limit: 20, used }));
      assert.throws(() => openLiveSmokeBudget(root, "synthetic-grant"), /LIVE_SMOKE_BUDGET_INVALID/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a separately approved six-request grant survives a restart and rejects the seventh", () => {
  const root = mkdtempSync(join(tmpdir(), "gv-budget-six-test-"));
  let budget;
  try {
    budget = openLiveSmokeBudget(root, "separate-six-request-grant", 6);
    for (let index = 1; index <= 3; index++) assert.equal(budget.reserve(), index);
    budget.close();
    budget = openLiveSmokeBudget(root, "separate-six-request-grant", 6);
    assert.equal(budget.used, 3);
    for (let index = 4; index <= 6; index++) assert.equal(budget.reserve(), index);
    const before = readFileSync(join(root, "request-budget.json"));
    assert.throws(() => budget.reserve(), /LIVE_SMOKE_REQUEST_LIMIT/);
    assert.deepEqual(readFileSync(join(root, "request-budget.json")), before);
  } finally { budget?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an existing grant cannot change its limit in either direction", () => {
  const root = mkdtempSync(join(tmpdir(), "gv-budget-limit-test-"));
  try {
    for (const [original, replacement] of [[6, 20], [20, 6]]) {
      const ledger = join(root, "request-budget.json");
      writeFileSync(ledger, JSON.stringify({ grantId: "fixed-grant", limit: original, used: original }));
      const before = readFileSync(ledger);
      assert.throws(() => openLiveSmokeBudget(root, "fixed-grant", replacement), /LIVE_SMOKE_BUDGET_INVALID/);
      assert.deepEqual(readFileSync(ledger), before);
      assert.equal(existsSync(join(root, "grant.lock")), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid limits are rejected before creating a lock or a ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "gv-budget-invalid-limit-test-"));
  try {
    for (const limit of [0, -1, 21, 1.5, NaN, Infinity, "6", null]) {
      assert.throws(() => openLiveSmokeBudget(root, "fixed-grant", limit), /LIVE_SMOKE_BUDGET_INVALID/);
      assert.equal(existsSync(join(root, "grant.lock")), false);
      assert.equal(existsSync(join(root, "request-budget.json")), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
