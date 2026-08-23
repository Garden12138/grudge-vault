import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(desktopRoot, "../..");
const packageAliases = {
  "@grudge-vault/domain": join(repositoryRoot, "packages/domain/src/index.ts"),
  "@grudge-vault/shared": join(repositoryRoot, "packages/shared/src/index.ts"),
  "@grudge-vault/application": join(repositoryRoot, "packages/application/src/index.ts"),
  "@grudge-vault/object-vault": join(repositoryRoot, "packages/object-vault/src/index.ts"),
  "@grudge-vault/persistence-sqlite": join(repositoryRoot, "packages/persistence-sqlite/src/index.ts")
};

export default defineConfig(({ mode }) => {
  const outputRoot = join(desktopRoot, mode === "e2e" ? "out-e2e" : "out");
  return {
    main: {
      resolve: { alias: packageAliases },
      plugins: [externalizeDepsPlugin({ exclude: Object.keys(packageAliases) })],
      build: {
        outDir: join(outputRoot, "main"),
        rollupOptions: {
          external: ["electron", "better-sqlite3"],
          input: mode === "e2e"
            ? join(desktopRoot, "src/e2e/main.ts")
            : join(desktopRoot, "src/main/index.ts")
        }
      }
    },
    preload: {
      resolve: { alias: packageAliases },
      plugins: [externalizeDepsPlugin({ exclude: Object.keys(packageAliases) })],
      build: {
        outDir: join(outputRoot, "preload"),
        rollupOptions: {
          external: ["electron"],
          input: join(desktopRoot, "src/preload/index.ts"),
          output: { format: "cjs", entryFileNames: "index.cjs" }
        }
      }
    },
    renderer: {
      root: join(desktopRoot, "src/renderer"),
      resolve: { alias: packageAliases },
      plugins: [react()],
      build: {
        outDir: join(outputRoot, "renderer"),
        rollupOptions: { input: join(desktopRoot, "src/renderer/index.html") }
      }
    }
  };
});
