import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const modules = ["cache", "core"];

const packagesBaseDir = path.resolve("packages");

async function ensureExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    throw new Error(`Expected build output missing: ${filePath}`);
  }
}

async function writeShim({ moduleName }) {
  const libDir = path.join(packagesBaseDir, moduleName, "lib");
  const expectedJs = path.join(libDir, `${moduleName}.js`);
  const targetCjs = path.join(libDir, `${moduleName}.cjs`);

  // Ensure TypeScript build actually produced the JS entrypoint we’re shimming.
  await ensureExists(expectedJs);

  await mkdir(libDir, { recursive: true });

  const contents = `module.exports = require('./${moduleName}.js');\n`;
  await writeFile(targetCjs, contents, "utf8");

  console.log(`Generated: ${path.relative(process.cwd(), targetCjs)}`);
}

async function main() {
  const failures = [];

  for (const moduleName of modules) {
    try {
      await writeShim({ moduleName });
    } catch (e) {
      failures.push({ moduleName, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failures.length) {
    for (const f of failures) {
      console.error(`[${f.moduleName}] ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
