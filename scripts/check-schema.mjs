import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The extension's schema is vendored under test/fixtures/ext-tasks (see the
// PROVENANCE.md there for why). Vendoring buys a hermetic, offline test suite
// and costs one thing: the copy goes stale silently. This turns that into a
// signal.
//
// Deliberately NOT part of `pnpm test` or the CI matrix: it makes a network
// call, and an upstream edit — or GitHub being unreachable — would otherwise
// fail every unrelated pull request. Run it deliberately, and on the schedule
// the repository keeps for it.
//
//   node scripts/check-schema.mjs           compare, exit 1 on drift
//   node scripts/check-schema.mjs --write    refresh the fixtures

const REPO = "modelcontextprotocol/ext-tasks";
const FILES = ["schema.json", "schema.ts"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "ext-tasks");
const write = process.argv.includes("--write");

async function upstream(file) {
  const url = `https://raw.githubusercontent.com/${REPO}/main/schema/draft/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  return response.text();
}

let drifted = false;

for (const file of FILES) {
  const local = path.join(fixtures, file);
  // Normalise line endings before comparing. .gitattributes checks the
  // repository out with LF, but raw.githubusercontent serves whatever is in
  // the blob, and a CRLF difference is not schema drift.
  const mine = readFileSync(local, "utf8").replace(/\r\n/g, "\n");
  const theirs = (await upstream(file)).replace(/\r\n/g, "\n");

  if (mine === theirs) {
    console.log(`${file}: up to date`);
    continue;
  }

  drifted = true;
  if (write) {
    writeFileSync(local, theirs);
    console.log(
      `${file}: REFRESHED — review the diff and update PROVENANCE.md`,
    );
  } else {
    console.error(
      `${file}: DRIFTED from ${REPO}. Re-run with --write, review what changed, ` +
        `and update the SHAs in test/fixtures/ext-tasks/PROVENANCE.md in the same commit.`,
    );
  }
}

if (drifted && !write) {
  process.exitCode = 1;
} else if (drifted && write) {
  console.log(
    "\nFixtures refreshed. A schema change is a contract change: check it " +
      "against docs/contract.md before assuming the tests passing means anything.",
  );
}
