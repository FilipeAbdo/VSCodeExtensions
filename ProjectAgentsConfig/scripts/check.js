const { spawnSync } = require("node:child_process");

console.log("Syntax check starting");
for (const file of ["extension.js", "templateManager.js", "media/templates.js"]) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status === null ? 1 : result.status;
    break;
  }
}
if (!process.exitCode) {
  console.log("Syntax check succeeded");
}
