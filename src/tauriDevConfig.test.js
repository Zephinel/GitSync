import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const releaseConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)),
);
const devConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url)),
);

test("Tauri development config uses a separate app identity", () => {
  assert.equal(packageJson.scripts["tauri:dev"], "tauri dev --config src-tauri/tauri.dev.conf.json");
  assert.equal(releaseConfig.identifier, "com.gitsync.desktop");
  assert.equal(devConfig.identifier, "com.gitsync.desktop.dev");
  assert.notEqual(devConfig.identifier, releaseConfig.identifier);
  assert.equal(devConfig.productName, "GitSync Dev");
  assert.equal(devConfig.app.windows[0].title, "GitSync Dev");
});
