// Test-only module tracing. Never used for timing measurements or production execution.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const destination = process.env.SCRIVENER_TEST_MODULE_LOG;
if (!destination) throw new Error("A module trace destination is required.");
const loaded: string[] = [];
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    loaded.push(url);
    return result;
  },
});
process.on("exit", () => writeFileSync(destination, JSON.stringify(loaded)));
