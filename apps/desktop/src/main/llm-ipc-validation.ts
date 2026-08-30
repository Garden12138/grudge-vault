import { z } from "zod";

export const llmProviderSchema = z.enum(["nvidia", "openrouter", "bailian"]);
export const bailianRegionSchema = z.enum(["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong"]);

function validateRegion(
  value: { provider: z.infer<typeof llmProviderSchema>; region?: z.infer<typeof bailianRegionSchema> | undefined },
  context: z.RefinementCtx
): void {
  if (value.provider === "bailian" && !value.region) {
    context.addIssue({ code: "custom", message: "A region is required for Bailian." });
  }
  if (value.provider !== "bailian" && value.region) {
    context.addIssue({ code: "custom", message: "This provider does not use a region." });
  }
}

export const llmConnectSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().trim().min(1).max(200),
  region: bailianRegionSchema.optional(),
  apiKey: z.string().trim().min(1).max(10_000).optional()
}).strict().superRefine(validateRegion);

export const llmListModelsSchema = z.object({
  provider: llmProviderSchema,
  region: bailianRegionSchema.optional(),
  apiKey: z.string().trim().min(1).max(10_000).optional()
}).strict().superRefine(validateRegion);
