import type { GrudgeVaultApplication } from "@grudge-vault/application";
import type { Reminder } from "@grudge-vault/domain";

export class ContinuousMemoryScheduler {
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly application: GrudgeVaultApplication,
    private readonly onDue: (reminder: Reminder) => void
  ) {}

  start(): void {
    this.stop();
    this.run();
    this.interval = setInterval(() => this.run(), 15 * 60_000);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private run(): void {
    try {
      for (const reminder of this.application.runReviewAutomation()) this.onDue(reminder);
    } catch {
      // The in-app scheduler is best effort and resumes on the next unlocked tick.
    }
  }
}
