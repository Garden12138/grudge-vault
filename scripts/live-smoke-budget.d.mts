export function openLiveSmokeBudget(root: string, grantId: string, limit?: number): {
  readonly used: number;
  reserve(): number;
  close(): void;
};
