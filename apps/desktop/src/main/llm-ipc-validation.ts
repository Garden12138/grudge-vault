import { z } from "zod";
import type { LlmSettings } from "@grudge-vault/domain";

export const llmProviderSchema = z.enum(["bailian", "minimax"]);
export const bailianRegionSchema = z.enum(["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong"]);

/** Legacy provider configuration stays in the workspace for rollback, but is not active in the redesigned UI. */
export function redesignLlmSettings(settings: LlmSettings): LlmSettings {
  const candidate = settings.activeProvider === "bailian" || settings.activeProvider === "minimax"
    ? settings.activeProvider : undefined;
  const activeConfig = candidate ? settings.providers[candidate] : undefined;
  const activeProvider = activeConfig?.status === "ready" && activeConfig.credentialConfigured ? candidate : undefined;
  return {
    providers: {
      ...(settings.providers.bailian ? { bailian: settings.providers.bailian } : {}),
      ...(settings.providers.minimax ? { minimax: settings.providers.minimax } : {})
    },
    ...(activeProvider ? { activeProvider } : {})
  };
}

function validateRegion(
  value: {
    provider: z.infer<typeof llmProviderSchema>;
    region?: z.infer<typeof bailianRegionSchema> | undefined;
    workspaceId?: string | undefined;
  },
  context: z.RefinementCtx
): void {
  if (value.provider === "bailian" && !value.region) {
    context.addIssue({ code: "custom", message: "A region is required for Bailian." });
  }
  if (value.provider !== "bailian" && value.region) {
    context.addIssue({ code: "custom", message: "This provider does not use a region." });
  }
  if (value.provider !== "bailian" && value.workspaceId) {
    context.addIssue({ code: "custom", message: "This provider does not use a Workspace ID." });
  }
}

const workspaceIdSchema = z.string().trim().regex(/^[A-Za-z0-9-]{1,63}$/).optional();

export const llmConnectSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().trim().min(1).max(200),
  region: bailianRegionSchema.optional(),
  workspaceId: workspaceIdSchema,
  apiKey: z.string().trim().min(1).max(10_000).optional()
}).strict().superRefine(validateRegion);

export const llmListModelsSchema = z.object({
  provider: llmProviderSchema,
  region: bailianRegionSchema.optional(),
  workspaceId: workspaceIdSchema,
  apiKey: z.string().trim().min(1).max(10_000).optional(),
  recommendationsOnly: z.boolean().optional()
}).strict().superRefine(validateRegion);
