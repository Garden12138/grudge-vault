import type { GrudgeVaultApi } from "@grudge-vault/shared";

declare global {
  interface Window {
    grudgeVault: GrudgeVaultApi;
  }
}

export {};
