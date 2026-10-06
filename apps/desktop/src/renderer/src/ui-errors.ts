import type { AppErrorCode, IpcResult } from "@grudge-vault/shared";

export class UiError extends Error {
  constructor(readonly code: AppErrorCode, message: string, readonly retryable: boolean) { super(message); }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new UiError(result.error.code, result.error.message, result.error.retryable);
  return result.data;
}

export function displayError(error: unknown): string {
  if (error instanceof UiError) {
    const known: Partial<Record<AppErrorCode, string>> = {
      MODEL_NOT_CONFIGURED: "请先在设置中连接并启用百炼或 MiniMax。",
      MODALITY_UNAVAILABLE: "当前模型无法完整处理所选媒体。MiniMax 主模型的音视频任务需要先在设置中配置并测试百炼 Omni 辅助能力；也可启用百炼 Omni 作为主模型。若仍超出分段限制或格式不支持，请调整原件后重试。",
      LLM_AUTHENTICATION_FAILED: "模型密钥验证失败，请在设置中检查密钥并重新测试连接。",
      LLM_REGION_MISMATCH: "模型密钥与百炼地域可能不匹配，请检查设置后重新测试连接。",
      LLM_CONFIGURATION_CHANGED: "工作区或模型配置已变化，原任务已失效，请按当前配置重新执行。",
      LLM_MODEL_NOT_FOUND: "所选模型不可用，请在设置中检查模型 ID。",
      LLM_TOOL_UNSUPPORTED: "所选模型不支持本次结构化判断，请在设置中换用支持的模型。",
      LLM_RATE_LIMITED: "模型服务暂时限流；输入仍在编辑器中，请稍后重试。",
      SOURCE_UNAVAILABLE: "原始输入已失效或附件发生变化，请重新选择完整内容。",
      SCREENING_FAILED: "未完成判断，请重试。",
      CLEANUP_FAILED: "清理临时内容失败，请先检查工作区状态，不要重复提交。",
      REVISION_CONFLICT: "记录已在其他位置更新，请重新载入后再保存。",
      WORKSPACE_MIGRATION_REQUIRED: "这是旧版工作区。请先创建独立的新版工作区，再从设置中筛选迁移。",
      ASSET_PREVIEW_UNAVAILABLE: "这个原件超出当前安全预览能力或预览占用达到上限；请先关闭其他预览，或保存原始副本后查看。",
      ASSET_CORRUPT: "原件完整性校验失败，暂时不能预览。"
    };
    return known[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : "发生了未知错误。";
}
