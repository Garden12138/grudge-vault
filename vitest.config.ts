import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@grudge-vault/domain": fromRoot("./packages/domain/src/index.ts"),
      "@grudge-vault/shared": fromRoot("./packages/shared/src/index.ts"),
      "@grudge-vault/application": fromRoot("./packages/application/src/index.ts"),
      "@grudge-vault/importer-dayone": fromRoot("./packages/importer-dayone/src/index.ts"),
      "@grudge-vault/persistence-sqlite": fromRoot("./packages/persistence-sqlite/src/index.ts"),
      "@grudge-vault/object-vault": fromRoot("./packages/object-vault/src/index.ts"),
      "@grudge-vault/media-pipeline": fromRoot("./packages/media-pipeline/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: { reporter: ["text", "html"] }
  }
});
