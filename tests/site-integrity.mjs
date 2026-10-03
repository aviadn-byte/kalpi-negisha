import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(testDirectory, "../dist");
const html = fs.readFileSync(path.join(siteDirectory, "index.html"), "utf8");
const app = fs.readFileSync(path.join(siteDirectory, "app.js"), "utf8");
const dataSource = fs.readFileSync(path.join(siteDirectory, "data.js"), "utf8");
const context = { window: {} };
vm.runInNewContext(dataSource, context, { filename: "data.js" });
const data = context.window.POLLING_DATA;

const expectedByCommittee = {
  "01": [290, 199], "02": [311, 212], "03": [135, 108], "04": [101, 78],
  "05": [396, 252], "06": [261, 165], "07": [168, 97], "08": [245, 132],
  "09": [357, 194], "10": [336, 201], "11": [313, 158], "12": [338, 166],
  "13": [410, 203], "14": [379, 213], "15": [310, 190], "16": [264, 126],
  "17": [436, 247], "18": [555, 350], "19": [337, 179], "20": [266, 150],
};

assert.ok(data && Array.isArray(data.records), "data.js must expose a records array");
assert.equal(data.records.length, 6208, "detailed report row count");
assert.equal(data.meta.accessibleBallots, 6208, "accessible total");
assert.equal(data.meta.specialAccessibleBallots, 3620, "special-accessible total");
assert.equal(data.meta.allBallots, 12018, "all-ballots control total");
assert.equal(data.meta.localities, 1224, "all-localities control total");
assert.equal(data.meta.clusters, 4399, "all-clusters control total");
assert.equal(data.meta.eligibleVoters, 7331981, "eligible-voters control total");

const keySet = new Set();
const actualByCommittee = {};
let specialTotal = 0;
for (const record of data.records) {
  for (const field of ["committeeCode", "committee", "localityCode", "locality", "ballot", "cluster", "address", "place"] ) {
    assert.ok(String(record[field] ?? "").trim(), `record field ${field} must not be blank`);
  }
  const key = `${record.localityCode}\u0001${record.ballot}`;
  assert.ok(!keySet.has(key), `duplicate polling-station key ${key}`);
  keySet.add(key);
  const bucket = actualByCommittee[record.committeeCode] || [0, 0];
  bucket[0] += 1;
  bucket[1] += record.special ? 1 : 0;
  actualByCommittee[record.committeeCode] = bucket;
  specialTotal += record.special ? 1 : 0;
}
assert.equal(specialTotal, 3620, "special flag count");
assert.deepEqual(actualByCommittee, expectedByCommittee, "committee controls from report 137");

assert.match(html, /http-equiv="Content-Security-Policy"/i, "CSP meta policy");
assert.match(html, /name="referrer" content="strict-origin-when-cross-origin"/i, "referrer policy");
assert.match(html, /id="embedded-map"/i, "embedded map region");
assert.match(
  html,
  /https:\/\/www\.gov\.il\/he\/pages\/26elections-info\?chapterIndex=2/,
  "official Central Elections Committee source link",
);
assert.match(app, /travelmode=walking/, "walking travel mode");
assert.doesNotMatch(app, /\b(?:eval|Function)\s*\(|document\.write|\.innerHTML\s*=/, "unsafe dynamic execution or HTML injection");

const blankTargetLinks = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gi)];
assert.ok(blankTargetLinks.length > 0, "external links are present");
for (const [link] of blankTargetLinks) {
  assert.match(link, /rel="[^"]*noopener[^"]*noreferrer[^"]*"/i, "new-tab links must isolate the opener");
}

const combinedSource = `${html}\n${app}\n${dataSource.slice(0, 2000)}`;
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{30,}/,
  /\bsk-[0-9A-Za-z_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const pattern of secretPatterns) {
  assert.doesNotMatch(combinedSource, pattern, "no embedded credential material");
}

console.log("PASS: 6,208 records, 20 committee controls, security invariants, and map controls validated.");
