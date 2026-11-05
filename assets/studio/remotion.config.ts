import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";

// Remotion downloads a Chrome Headless Shell on first render. If that download
// is blocked (corporate proxy, offline), point REMOTION_BROWSER at a local
// Chrome/Chromium binary, or pass --browser-executable=<path> on the CLI.
const chromeOnWindows = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser =
  process.env.REMOTION_BROWSER ??
  (existsSync(chromeOnWindows) ? chromeOnWindows : undefined);

if (browser) {
  Config.setBrowserExecutable(browser);
}
