import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The extension's schema is vendored under test/fixtures/ext-tasks (see the
// PROVENANCE.md there for why). Vendoring buys a hermetic, offline test suite
// and costs one thing: the copy goes stale silently. This turns that into a
// signal.
//
// Deliberately NOT part of `pnpm test` or the CI matrix: it makes a network
// call, and an upstream edit — or GitHub being unreachable — would otherwise
// fail every unrelated pull request. Run it deliberately, and before a tag.
//
//   node scripts/check-schema.mjs           compare, exit 1 on drift
//   node scripts/check-schema.mjs --write    refresh the fixtures
//
// The fixtures track the released `2026-07-28` snapshot, which upstream marks
// immutable — so drift there is a real event, not routine churn. After that
// comparison the script also reports, for information only, whether upstream's
// moving `draft` has diverged from the snapshot. That line never changes the
// exit code: `draft` is not a conformance target (docs/contract.md#scope-and-authority).

const REPO = "modelcontextprotocol/ext-tasks";
const REVISION = "2026-07-28";
// `schema.ts` imports its MCP base types from `spec.types.ts`, including the
// concrete InputRequest/InputResponse unions, so the authoritative source is
// only complete with both.
const FILES = ["schema.json", "schema.ts", "spec.types.ts"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "ext-tasks");
const write = process.argv.includes("--write");

// Normalise line endings before comparing. .gitattributes checks the
// repository out with LF, but raw.githubusercontent serves whatever is in the
// blob, and a CRLF difference is not schema drift.
const lf = (text) => text.replace(/\r\n/g, "\n");

async function upstream(revision, file) {
  const url = `https://raw.githubusercontent.com/${REPO}/main/schema/${revision}/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} responded ${response.status}`);
  }
  return lf(await response.text());
}

let drifted = false;
const pinned = new Map();

for (const file of FILES) {
  const local = path.join(fixtures, file);
  // A missing fixture is drift too; `--write` creates it.
  const mine = existsSync(local) ? lf(readFileSync(local, "utf8")) : undefined;
  const theirs = await upstream(REVISION, file);
  pinned.set(file, theirs);

  if (mine === theirs) {
    console.log(`${file}: up to date with schema/${REVISION}`);
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
      `${file}: DRIFTED from ${REPO} schema/${REVISION}. Re-run with --write, ` +
        `review what changed, and update the SHAs in ` +
        `test/fixtures/ext-tasks/PROVENANCE.md in the same commit.`,
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

// Informational only; see the header.
try {
  const moved = [];
  for (const file of FILES) {
    if ((await upstream("draft", file)) !== pinned.get(file)) moved.push(file);
  }
  console.log(
    moved.length === 0
      ? `\ninfo: draft is identical to ${REVISION}.`
      : `\ninfo: draft has diverged from ${REVISION} in ${moved.join(", ")}. ` +
          `Not a conformance target; read it when preparing the next revision.`,
  );
} catch (error) {
  console.log(`\ninfo: draft comparison skipped (${error.message}).`);
}
