#!/usr/bin/env -S npx tsx

/**
 * Integration-test verifier. Nodes POST their confirmed port to `/report`; the
 * observer passes once every node has reported a distinct port. The result is
 * served at `/results` and logged. Replaces the old multicast OBSERVE mode.
 */

import { createServer } from "node:http";

const nodeCount = process.env.NODE_COUNT ? +process.env.NODE_COUNT : 8;
const port = process.env.PORT ? +process.env.PORT : 33333;
const timeoutSec = process.env.TIMEOUT_SEC ? +process.env.TIMEOUT_SEC : 120;

const results = new Map<string, number>(); // nid -> confirmed port
let announcedPass = false;

function summary() {
  const ports = [...results.values()];
  const distinct = new Set(ports).size;
  const pass = results.size === nodeCount && distinct === nodeCount;
  return {
    nodeCount,
    reported: results.size,
    distinct,
    pass,
    results: Object.fromEntries(results)
  };
}

function evaluate(): void {
  const s = summary();
  if (s.pass && !announcedPass) {
    announcedPass = true;
    console.log(`PASS: ${nodeCount} nodes hold ${s.distinct} distinct ports`);
    console.log(JSON.stringify(s.results));
    setTimeout(() => process.exit(0), 2000); // let the run settle, then exit 0
  } else if (!s.pass) {
    console.log(
      `progress: ${s.reported}/${nodeCount} reported, ${s.distinct} distinct`
    );
  }
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { nid, port: claimed } = JSON.parse(body);
        if (typeof nid === "string" && typeof claimed === "number") {
          results.set(nid, claimed);
          evaluate();
        }
      } catch {
        // ignore malformed report
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(summary()));
});

server.listen(port, () =>
  console.log(`Observer on :${port}, expecting ${nodeCount} nodes`)
);

// hard timeout makes this a real gate: fail the run if we never converge
setTimeout(() => {
  if (!announcedPass) {
    console.log(`FAIL: timed out after ${timeoutSec}s`);
    console.log(JSON.stringify(summary()));
    process.exit(1);
  }
}, timeoutSec * 1000);
