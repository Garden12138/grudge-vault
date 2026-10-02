import { spawnSync } from "node:child_process";
import process from "node:process";
import { prepareNativeMedia } from "./prepare-native-media.mjs";

if (process.platform !== "darwin") throw new Error("The native media gate must run on macOS.");
prepareNativeMedia();
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
  "apps/desktop/src/main/native-media-integration.test.ts", "apps/desktop/src/main/native-image-integration.test.ts"], {
  stdio: "inherit", env: { ...process.env, GRUDGE_VAULT_NATIVE_MEDIA_TEST: "1" }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
