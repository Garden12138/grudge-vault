import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import type { CaseSummaryPdfPort } from "@grudge-vault/application";

/** Renders a Binder cover sheet without granting the document network or filesystem access. */
export class ElectronCaseSummaryPdfRenderer implements CaseSummaryPdfPort {
  async render(input: { title: string; locale: "zh-CN" | "en"; html: string }): Promise<Buffer> {
    const partition = `case-binder-pdf-${randomUUID()}`;
    const pdfSession = session.fromPartition(partition, { cache: false });
    pdfSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    pdfSession.setPermissionCheckHandler(() => false);
    pdfSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith("data:text/html") });
    });
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(input.html)}`);
      return await window.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false
      });
    } finally {
      if (!window.isDestroyed()) window.destroy();
      await pdfSession.clearStorageData();
    }
  }
}
