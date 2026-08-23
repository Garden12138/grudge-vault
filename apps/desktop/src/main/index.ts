import { app } from "electron";
import { bootstrap } from "./bootstrap";

app.enableSandbox();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}
