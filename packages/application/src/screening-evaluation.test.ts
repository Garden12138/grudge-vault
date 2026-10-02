import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { syntheticScreeningCases } from "../../../tests/fixtures/screening-cases";
import { evaluateScreeningPredictions } from "./screening-evaluation";

const exactPredictions = syntheticScreeningCases.map(({ id, expected }) => ({ id, decision: expected }));
const scoreMetrics = ["relatedRecall", "autoIncludePrecision", "reviewRoutingAccuracy"] as const;
type ScoreMetric = typeof scoreMetrics[number];
function boundaryDataset(metric: ScoreMetric, denominator: number) {
  const threshold = metric === "reviewRoutingAccuracy" ? 85 : 95;
  const matched = Math.floor(denominator * threshold / 100);
  const labels: Array<{ id: string; expected: "include" | "skip" | "review" }> = [];
  const predictions: Array<{ id: string; decision: "include" | "skip" | "review" }> = [];
  const add = (id: string, expected: "include" | "skip" | "review", decision: "include" | "skip" | "review") => {
    labels.push({ id, expected }); predictions.push({ id, decision });
  };
  for (let index = 0; index < denominator; index++) {
    const correct = index < matched;
    if (metric === "relatedRecall") add(`synthetic-${index}`, "include", correct ? "include" : "skip");
    else if (metric === "autoIncludePrecision") add(`synthetic-${index}`, correct ? "include" : "skip", "include");
    else add(`synthetic-${index}`, "review", correct ? "review" : "skip");
  }
  if (metric !== "reviewRoutingAccuracy") add("synthetic-review-control", "review", "review");
  else add("synthetic-include-control", "include", "include");
  add("synthetic-skip-control", "skip", "skip");
  return { labels, predictions, matched, denominator, threshold };
}

describe("screening quality scorecard", () => {
  it("computes the plan thresholds without treating synthetic labels as real quality evidence", () => {
    const result = evaluateScreeningPredictions({
      datasetKind: "synthetic", labels: syntheticScreeningCases, predictions: exactPredictions
    });
    expect(result).toMatchObject({
      datasetKind: "synthetic", total: 200, decided: 200, errors: 0, missing: 0,
      dangerSkipped: 0, ordinaryFalseIncludes: 0,
      relatedRecallPercent: 100, autoIncludePrecisionPercent: 100, reviewRoutingAccuracyPercent: 100,
      thresholdsPass: true
    });
  });

  it("keeps errors and missing predictions distinct from skip and fails unsafe thresholds", () => {
    const predictions: Array<{ id: string; decision: "include" | "skip" | "review" | "error" }> = exactPredictions.filter(({ id }) => id !== "related-001")
      .map((item) => ({ ...item }));
    predictions.find(({ id }) => id === "related-006")!.decision = "skip";
    predictions.find(({ id }) => id === "ordinary-001")!.decision = "include";
    predictions.find(({ id }) => id === "review-001")!.decision = "error";
    const result = evaluateScreeningPredictions({
      datasetKind: "synthetic", labels: syntheticScreeningCases, predictions
    });
    expect(result).toMatchObject({
      missing: 1, errors: 1, dangerSkipped: 1, ordinaryFalseIncludes: 1,
      thresholds: { allCasesDecided: false, noDangerSkipped: false }, thresholdsPass: false
    });
    expect(result.details).toMatchObject({
      missingIds: ["related-001"], errorIds: ["review-001"],
      dangerSkippedIds: ["related-006"], ordinaryFalseIncludeIds: ["ordinary-001"]
    });
  });

  it("rejects duplicate and unknown prediction IDs rather than silently skewing denominators", () => {
    expect(() => evaluateScreeningPredictions({
      datasetKind: "external", labels: syntheticScreeningCases,
      predictions: [...exactPredictions, exactPredictions[0]]
    })).toThrow("重复样本 ID");
    expect(() => evaluateScreeningPredictions({
      datasetKind: "external", labels: syntheticScreeningCases,
      predictions: [...exactPredictions, { id: "unknown", decision: "skip" }]
    })).toThrow("以外的样本 ID");
  });

  it.each(scoreMetrics)("does not round a below-threshold %s result into a pass", (metric) => {
    const data = boundaryDataset(metric, 20_001);
    const result = evaluateScreeningPredictions({ datasetKind: "synthetic", labels: data.labels, predictions: data.predictions });
    const displayedPercent = metric === "relatedRecall" ? result.relatedRecallPercent
      : metric === "autoIncludePrecision" ? result.autoIncludePrecisionPercent : result.reviewRoutingAccuracyPercent;
    expect(data.matched * 100).toBeLessThan(data.denominator * data.threshold);
    expect(displayedPercent).toBe(data.threshold);
    expect(result.metricCounts[metric]).toEqual({ matched: data.matched, total: data.denominator });
    expect(result.thresholds[metric]).toBe(false);
    expect(result.thresholdsPass).toBe(false);
  });

  it.each(scoreMetrics)("accepts exactly the specified %s boundary", (metric) => {
    const data = boundaryDataset(metric, 20);
    expect(data.matched * 100).toBe(data.denominator * data.threshold);
    const result = evaluateScreeningPredictions({ datasetKind: "synthetic", labels: data.labels, predictions: data.predictions });
    expect(result.thresholds[metric]).toBe(true);
    expect(result.thresholdsPass).toBe(true);
  });

  it("the CLI rejects a rounded borderline score without printing synthetic case IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-evaluation-boundary-"));
    try {
      const data = boundaryDataset("relatedRecall", 20_001);
      const labelsPath = join(directory, "labels.json"), predictionsPath = join(directory, "predictions.json");
      await writeFile(labelsPath, JSON.stringify(data.labels)); await writeFile(predictionsPath, JSON.stringify(data.predictions));
      const result = spawnSync(process.execPath, [resolve("scripts/evaluate-screening.mjs"),
        "--labels", labelsPath, "--predictions", predictionsPath], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ relatedRecallPercent: 95,
        metricCounts: { relatedRecall: { matched: 19_000, total: 20_001 } },
        thresholds: { relatedRecall: false }, thresholdsPass: false });
      expect(JSON.parse(result.stdout).releaseGateEvidence).toContain("not-established");
      expect(result.stdout).not.toContain("synthetic-0");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("prints aggregate metrics by default without diary text or case IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-evaluation-"));
    try {
      const path = join(directory, "predictions.json");
      await writeFile(path, JSON.stringify(exactPredictions));
      const result = spawnSync(process.execPath, [
        resolve("scripts/evaluate-screening.mjs"), "--synthetic", "--predictions", path
      ], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ total: 200, thresholdsPass: true });
      expect(output.releaseGateEvidence).toContain("not-established");
      expect(output.details).toBeUndefined();
      expect(result.stdout).not.toContain(syntheticScreeningCases[0]!.text);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scores external labels locally and exits nonzero for a dangerous skip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-evaluation-external-"));
    try {
      const labelsPath = join(directory, "labels.json");
      const predictionsPath = join(directory, "predictions.json");
      await writeFile(labelsPath, JSON.stringify([
        { id: "case-danger", expected: "include", category: "danger", text: "private marker must not print" },
        { id: "case-review", expected: "review" }, { id: "case-ordinary", expected: "skip" }
      ]));
      await writeFile(predictionsPath, JSON.stringify([
        { id: "case-danger", decision: "skip" },
        { id: "case-review", decision: "review" }, { id: "case-ordinary", decision: "skip" }
      ]));
      const result = spawnSync(process.execPath, [
        resolve("scripts/evaluate-screening.mjs"), "--labels", labelsPath, "--predictions", predictionsPath
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        datasetKind: "external", dangerSkipped: 1, thresholdsPass: false
      });
      expect(result.stdout).not.toContain("private marker must not print");
      expect(result.stdout).not.toContain("case-danger");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
