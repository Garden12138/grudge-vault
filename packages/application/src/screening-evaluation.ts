import { z } from "zod";

const decisionSchema = z.enum(["include", "skip", "review"]);
const labelSchema = z.object({
  id: z.string().trim().min(1).max(200), expected: decisionSchema,
  category: z.enum(["grudge", "rights", "danger"]).optional()
});
const predictionSchema = z.object({
  id: z.string().trim().min(1).max(200), decision: z.enum(["include", "skip", "review", "error"])
});

export interface ScreeningEvaluationResult {
  datasetKind: "synthetic" | "external";
  total: number;
  decided: number;
  errors: number;
  missing: number;
  dangerSkipped: number;
  ordinaryFalseIncludes: number;
  relatedRecallPercent: number;
  autoIncludePrecisionPercent: number;
  reviewRoutingAccuracyPercent: number;
  /** Aggregate ratios explain a rounded display value near a strict acceptance boundary. */
  metricCounts: {
    relatedRecall: { matched: number; total: number };
    autoIncludePrecision: { matched: number; total: number };
    reviewRoutingAccuracy: { matched: number; total: number };
  };
  thresholds: {
    allCasesDecided: boolean;
    noDangerSkipped: boolean;
    relatedRecall: boolean;
    autoIncludePrecision: boolean;
    reviewRoutingAccuracy: boolean;
  };
  thresholdsPass: boolean;
  /** IDs only; do not print for private datasets unless explicitly requested. */
  details: {
    missingIds: string[];
    errorIds: string[];
    dangerSkippedIds: string[];
    ordinaryFalseIncludeIds: string[];
  };
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round(numerator / denominator * 10_000) / 100;
}

export function evaluateScreeningPredictions(input: {
  datasetKind: "synthetic" | "external";
  labels: unknown;
  predictions: unknown;
}): ScreeningEvaluationResult {
  const labels = z.array(labelSchema).min(1).max(100_000).parse(input.labels);
  const predictions = z.array(predictionSchema).max(100_000).parse(input.predictions);
  const byId = new Map(labels.map((label) => [label.id, label]));
  if (byId.size !== labels.length) throw new Error("标签数据包含重复样本 ID。");
  const decisions = new Map(predictions.map((prediction) => [prediction.id, prediction.decision]));
  if (decisions.size !== predictions.length) throw new Error("模型预测包含重复样本 ID。");
  if (predictions.some(({ id }) => !byId.has(id))) throw new Error("模型预测包含标签数据以外的样本 ID。");

  const related = labels.filter(({ expected }) => expected === "include");
  const review = labels.filter(({ expected }) => expected === "review");
  const automaticallyIncluded = labels.filter(({ id }) => decisions.get(id) === "include");
  const missingIds = labels.filter(({ id }) => !decisions.has(id)).map(({ id }) => id);
  const errorIds = labels.filter(({ id }) => decisions.get(id) === "error").map(({ id }) => id);
  const dangerSkippedIds = labels.filter(({ id, category }) =>
    category === "danger" && decisions.get(id) === "skip").map(({ id }) => id);
  const ordinaryFalseIncludeIds = labels.filter(({ id, expected }) =>
    expected === "skip" && decisions.get(id) === "include").map(({ id }) => id);
  const metricCounts = {
    relatedRecall: { matched: related.filter(({ id }) =>
      decisions.get(id) === "include" || decisions.get(id) === "review").length, total: related.length },
    autoIncludePrecision: { matched: automaticallyIncluded.filter(({ expected }) =>
      expected === "include").length, total: automaticallyIncluded.length },
    reviewRoutingAccuracy: { matched: review.filter(({ id }) => decisions.get(id) === "review").length, total: review.length }
  };
  const relatedRecallPercent = percent(metricCounts.relatedRecall.matched, metricCounts.relatedRecall.total);
  const autoIncludePrecisionPercent = percent(metricCounts.autoIncludePrecision.matched, metricCounts.autoIncludePrecision.total);
  const reviewRoutingAccuracyPercent = percent(metricCounts.reviewRoutingAccuracy.matched, metricCounts.reviewRoutingAccuracy.total);
  // Display rounding must never turn a score below the plan's 95%/85% boundary into a pass.
  // Counts are bounded by 100,000, so these integer products remain exactly representable.
  const meets = ({ matched, total }: { matched: number; total: number }, threshold: number) =>
    total > 0 && matched * 100 >= total * threshold;
  const thresholds = {
    allCasesDecided: missingIds.length === 0 && errorIds.length === 0,
    noDangerSkipped: dangerSkippedIds.length === 0,
    relatedRecall: meets(metricCounts.relatedRecall, 95),
    autoIncludePrecision: meets(metricCounts.autoIncludePrecision, 95),
    reviewRoutingAccuracy: meets(metricCounts.reviewRoutingAccuracy, 85)
  };
  return {
    datasetKind: input.datasetKind, total: labels.length,
    decided: labels.length - missingIds.length - errorIds.length,
    errors: errorIds.length, missing: missingIds.length,
    dangerSkipped: dangerSkippedIds.length, ordinaryFalseIncludes: ordinaryFalseIncludeIds.length,
    relatedRecallPercent, autoIncludePrecisionPercent, reviewRoutingAccuracyPercent, metricCounts,
    thresholds, thresholdsPass: Object.values(thresholds).every(Boolean),
    details: { missingIds, errorIds, dangerSkippedIds, ordinaryFalseIncludeIds }
  };
}
