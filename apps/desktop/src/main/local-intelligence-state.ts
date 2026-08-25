import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION, type LocalIntelligenceConfiguration
} from "@grudge-vault/media-pipeline";

const mediaSettingsSchema = z.object({
  autoProcessNew: z.boolean(), ocrLanguages: z.array(z.string().min(1).max(80)).min(1).max(16),
  resourceProfile: z.enum(["conservative", "balanced", "performance"]), whisperGpu: z.enum(["auto", "cpu"])
});
const mediaSchema = z.object({
  formatVersion: z.literal(1), paths: z.record(z.string(), z.string()).default({}), settings: mediaSettingsSchema
});
const folderSchema = z.object({
  path: z.string().min(1), enabled: z.boolean(), lastScannedAt: z.iso.datetime().optional(), lastError: z.string().max(1000).optional()
});
const stateSchema = z.object({
  formatVersion: z.literal(1), media: mediaSchema, importFolders: z.record(z.string(), folderSchema)
});
export type ImportFolderMachineState = z.infer<typeof folderSchema>;

interface MachineState {
  formatVersion: 1;
  media: LocalIntelligenceConfiguration;
  importFolders: Record<string, ImportFolderMachineState>;
}

export class LocalIntelligenceStateStore {
  private state: MachineState = {
    formatVersion: 1, media: DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION, importFolders: {}
  };

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))) as MachineState;
    } catch {
      this.state = { formatVersion: 1, media: DEFAULT_LOCAL_INTELLIGENCE_CONFIGURATION, importFolders: {} };
    }
  }

  getMedia(): LocalIntelligenceConfiguration { return this.state.media; }
  async setMedia(media: LocalIntelligenceConfiguration): Promise<void> {
    this.state = { ...this.state, media };
    await this.save();
  }

  getImportFolder(workspaceKey: string): ImportFolderMachineState | undefined {
    return this.state.importFolders[workspaceKey];
  }

  async setImportFolder(workspaceKey: string, value: ImportFolderMachineState): Promise<void> {
    this.state = { ...this.state, importFolders: { ...this.state.importFolders, [workspaceKey]: value } };
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
