import type { Asset, Job, Workspace } from "@grudge-vault/domain";

export const APP_ERROR_CODES = [
  "NO_ACTIVE_WORKSPACE",
  "WORKSPACE_INVALID",
  "WORKSPACE_EXISTS",
  "WORKSPACE_KEY_UNAVAILABLE",
  "INSECURE_KEY_BACKEND",
  "FILE_NOT_REGULAR",
  "ASSET_IMPORT_FAILED",
  "ASSET_NOT_FOUND",
  "ASSET_CORRUPT",
  "JOB_NOT_RETRYABLE",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface SerializedAppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError };

export interface AssetImportResult {
  asset: Asset;
  deduplicated: boolean;
}

export interface GrudgeVaultApi {
  workspace: {
    current(): Promise<IpcResult<Workspace | null>>;
    create(name: string): Promise<IpcResult<Workspace | null>>;
    open(): Promise<IpcResult<Workspace | null>>;
  };
  assets: {
    importDropped(files: File[]): Promise<IpcResult<AssetImportResult[]>>;
    chooseAndImport(): Promise<IpcResult<AssetImportResult[]>>;
    list(): Promise<IpcResult<Asset[]>>;
    verify(assetId: string): Promise<IpcResult<Job>>;
  };
  jobs: {
    list(): Promise<IpcResult<Job[]>>;
    retry(jobId: string): Promise<IpcResult<Job>>;
    onChanged(callback: () => void): () => void;
  };
}

export function toSerializedError(error: unknown): SerializedAppError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL_ERROR", message: "An unexpected local error occurred.", retryable: false };
}
