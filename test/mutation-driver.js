'use strict';

// Mutation driver: applies each named mutation to the source, runs the test
// suite, records which tests went red, and restores the file byte-for-byte.
//
//   npm run mutate          (about 10 minutes: the full suite runs once per mutation)
//
// mutations.json: [{ "id": "M1", "file": "src/x.js", "find": "...", "replace": "...",
//                    "expect": "kill" | "survive" | "<test name substring>" }]
//
// Refuses (exit 2) when a "find" string does not occur exactly once: a mutation
// that does not apply is a vacuous row. Refuses when the suite is not green first.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repo = process.argv[2] || path.join(__dirname, '..');
const listFile = process.argv[3] || path.join(__dirname, 'mutations.json');
const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function runSuite() {
  const r = spawnSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', ...fs.readdirSync(path.join(repo, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(repo, 'test', f))],
    { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  const passed = [...out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, passed, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

const base = runSuite();
if (base.code !== 0 || base.failed.length) { console.error('Baseline is not green:', base.failed); process.exit(2); }
if (!base.passed.length) { console.error('Baseline ran no tests'); process.exit(2); }
console.log(`Baseline green: ${base.passed.length} tests\n`);

const results = [];
for (const m of list) {
  const file = path.join(repo, m.file);
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  const count = text.split(m.find).length - 1;
  if (count !== 1) { console.error(`${m.id}: "find" occurs ${count} times in ${m.file}; refusing a vacuous row`); process.exit(2); }
  fs.writeFileSync(file, text.replace(m.find, m.replace));
  let r;
  try { r = runSuite(); } finally { fs.writeFileSync(file, original); }
  if (sha(fs.readFileSync(file)) !== sha(original)) { console.error(`${m.id}: restore failed for ${m.file}`); process.exit(3); }
  const killed = r.code !== 0;
  let verdict;
  if (m.expect === 'survive') verdict = killed ? 'UNEXPECTED KILL' : 'survived (as predicted)';
  else if (m.expect === 'kill') verdict = killed ? 'killed' : 'SURVIVED';
  else verdict = !killed ? 'SURVIVED' : r.failed.some((f) => f.includes(m.expect)) ? `killed by "${m.expect}"` : 'KILLED BY THE WRONG TEST';
  results.push({ id: m.id, verdict, failed: r.failed.filter((f) => !/^test\/|\.js$/.test(f)) });
  console.log(`${m.id.padEnd(5)} ${verdict.padEnd(32)} ${m.what || ''}`);
  if (killed) console.log(`      red: ${r.failed.filter((f) => !/\.test\.js$/.test(f)).join(' | ') || '(suite crashed)'}`);
}
const final = runSuite();
console.log(`\nAfter restore: suite ${final.code === 0 ? 'green' : 'RED'} (${final.passed.length} passed)`);
const survivors = results.filter((r) => !r.verdict.startsWith('killed') && r.verdict !== 'survived (as predicted)');
if (survivors.length) console.log(`\n${survivors.length} mutation(s) not caught: ${survivors.map((r) => r.id).join(', ')}`);
process.exit(final.code !== 0 ? 3 : survivors.length ? 1 : 0);
