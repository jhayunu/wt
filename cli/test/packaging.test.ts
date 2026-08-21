import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The plugin's command and all three hooks invoke these paths directly
 * (`${CLAUDE_PLUGIN_ROOT}/bin/wt`, `…/scripts/*.sh`). Git carries the executable
 * bit into every clone and every plugin install, so a 100644 here means
 * "permission denied" on every machine — silently, because hooks swallow it.
 */
for (const rel of ["bin/wt", "scripts/session-start.sh", "scripts/prompt-context.sh", "scripts/stop.sh", "install.sh", "test/smoke.sh"]) {
  test(`${rel} is executable`, async () => {
    const mode = (await stat(path.join(root, rel))).mode;
    assert.ok(mode & 0o111, `${rel} is not executable (mode ${(mode & 0o777).toString(8)})`);
  });
}
