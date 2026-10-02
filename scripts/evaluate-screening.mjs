import { readFile, stat } from "node:fs/promises";
import { evaluateScreeningPredictions } from "../packages/application/src/screening-evaluation.ts";
import { syntheticScreeningCases } from "../tests/fixtures/screening-cases.ts";

const usage = "用法：node scripts/evaluate-screening.mjs (--synthetic | --labels 标签.json) --predictions 预测.json [--details]";
const args = globalThis.process.argv.slice(2);
const optionValue = (name) => {
  const position = args.indexOf(name);
  return position < 0 ? undefined : args[position + 1];
};

async function readBoundedJson(path) {
  if (!path || path.startsWith("--")) throw new Error(usage);
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("评估 JSON 文件不能超过 32 MB。");
  return JSON.parse(await readFile(path, "utf8"));
}

try {
  const synthetic = args.includes("--synthetic");
  const labelPath = optionValue("--labels");
  const predictionPath = optionValue("--predictions");
  const details = args.includes("--details");
  const known = new Set(["--synthetic", "--labels", "--predictions", "--details"]);
  if (synthetic === Boolean(labelPath) || !predictionPath || [...known].some((name) =>
    args.filter((arg) => arg === name).length > 1) || args.some((arg, index) =>
    arg.startsWith("--") && !known.has(arg) ||
    !arg.startsWith("--") && args[index - 1] !== "--labels" && args[index - 1] !== "--predictions")) {
    throw new Error(usage);
  }
  const result = evaluateScreeningPredictions({
    datasetKind: synthetic ? "synthetic" : "external",
    labels: synthetic ? syntheticScreeningCases : await readBoundedJson(labelPath),
    predictions: await readBoundedJson(predictionPath)
  });
  const { details: caseIds, ...summary } = result;
  globalThis.process.stdout.write(`${JSON.stringify({
    ...summary,
    releaseGateEvidence: synthetic
      ? "not-established: generated labels and scenario markers are not independent human review or real media"
      : "not-established: this scorer does not verify independent label provenance, media validity or live model behavior",
    ...(details ? { details: caseIds } : {})
  }, null, 2)}\n`);
  if (!result.thresholdsPass) globalThis.process.exitCode = 1;
} catch (error) {
  globalThis.process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  globalThis.process.exitCode = 2;
}
