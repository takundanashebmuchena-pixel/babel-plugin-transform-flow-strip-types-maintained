"use strict";

const fs = require("fs");
const path = require("path");

// ─── ANSI colors (no deps needed for basic output) ───────────────────────────
const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function log(msg) { process.stdout.write(msg + "\n"); }
function ok(msg)  { log(`${c.green}✔${c.reset} ${msg}`); }
function warn(msg){ log(`${c.yellow}⚠${c.reset} ${msg}`); }
function info(msg){ log(`${c.cyan}→${c.reset} ${msg}`); }
function err(msg) { log(`${c.red}✖${c.reset} ${msg}`); }

// ─── File helpers ─────────────────────────────────────────────────────────────
function findFiles(dir, exts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "dist", "build", ".next", "coverage"].includes(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

// ─── package.json migration ───────────────────────────────────────────────────
function migratePackageJson(rootDir) {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;

  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  let changed = false;

  const OLD = "babel-plugin-transform-flow-strip-types";
  const NEW = "babel-plugin-transform-flow-strip-types-maintained";

  for (const depKey of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (pkg[depKey] && pkg[depKey][OLD]) {
      pkg[depKey][NEW] = "^1.0.0";
      delete pkg[depKey][OLD];
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    ok(`package.json — replaced ${OLD} → ${NEW}`);
  }
  return changed;
}

// ─── .babelrc / babel.config.json migration ──────────────────────────────────
function migrateBabelConfig(rootDir) {
  const configs = [
    ".babelrc",
    ".babelrc.json",
    "babel.config.json",
    "babel.config.js",
    ".babelrc.js",
  ];

  let migrated = 0;
  for (const cfg of configs) {
    const cfgPath = path.join(rootDir, cfg);
    if (!fs.existsSync(cfgPath)) continue;

    let content = fs.readFileSync(cfgPath, "utf8");
    const OLD = "transform-flow-strip-types";
    const NEW = "transform-flow-strip-types-maintained";

    if (content.includes(OLD) && !content.includes(NEW)) {
      const updated = content.split(OLD).join(NEW);
      fs.writeFileSync(cfgPath, updated);
      ok(`${cfg} — updated plugin reference`);
      migrated++;
    }
  }
  return migrated;
}

// ─── Flow annotation stripping (basic) ───────────────────────────────────────
// Strips the most common Flow patterns from source files
// For full Flow→TS conversion, use the --full flag (pro feature)
const FLOW_PATTERNS = [
  // @flow pragma
  { re: /\/\/\s*@flow\s*(\w*)\n?/g, replace: "" },
  // import type
  { re: /import\s+type\s+\{[^}]+\}\s+from\s+['"][^'"]+['"]\s*;?\n?/g, replace: "" },
  // export type  
  { re: /export\s+type\s+\{[^}]+\}\s*;?\n?/g, replace: "" },
  // type alias: type Foo = ...;
  { re: /^type\s+\w+\s*(<[^>]*>)?\s*=\s*[^;]+;\n?/gm, replace: "" },
  // opaque type
  { re: /^opaque\s+type\s+[^;]+;\n?/gm, replace: "" },
  // inline type annotations: (x: string) → (x)
  { re: /(\w+)\s*:\s*([\w\[\]<>, |&?]+)(\s*[,)=])/g, replace: "$1$3" },
  // return type annotations: ): void {
  { re: /\)\s*:\s*[\w\[\]<>, |&?]+\s*(\{)/g, replace: ") $1" },
];

function stripFlowFromFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  if (!content.includes("@flow") && !content.includes(": string") && !content.includes(": number")) {
    return false; // skip, no flow annotations
  }

  let changed = false;
  for (const { re, replace } of FLOW_PATTERNS) {
    const updated = content.replace(re, replace);
    if (updated !== content) {
      content = updated;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
  }
  return changed;
}

// ─── REPORT ───────────────────────────────────────────────────────────────────
function printReport(stats) {
  log("");
  log(`${c.bold}────────────────────────────────${c.reset}`);
  log(`${c.bold}  flow-strip-migrate — Summary${c.reset}`);
  log(`${c.bold}────────────────────────────────${c.reset}`);
  ok(`package.json updated:     ${stats.pkgUpdated ? "yes" : "no"}`);
  ok(`Babel configs updated:    ${stats.babelConfigs}`);
  ok(`Source files scanned:     ${stats.scanned}`);
  ok(`Source files modified:    ${stats.modified}`);
  log("");
  if (stats.modified > 0) {
    info("Run your test suite to verify. Then: npm install");
  } else {
    info("No source changes needed. Run: npm install");
  }
  log(`${c.dim}Need full Flow→TypeScript conversion? Visit flowstrip.dev${c.reset}`);
  log("");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run(args) {
  const targetDir = args[0] || ".";
  const fullMode = args.includes("--full");
  const dryRun = args.includes("--dry-run");
  const resolvedDir = path.resolve(targetDir);

  log("");
  log(`${c.bold}${c.cyan}flow-strip-migrate v1.0.0${c.reset}`);
  log(`${c.dim}Migrating: ${resolvedDir}${c.reset}`);
  if (dryRun) warn("Dry-run mode — no files will be written");
  log("");

  const stats = {
    pkgUpdated: false,
    babelConfigs: 0,
    scanned: 0,
    modified: 0,
  };

  // Step 1: Update package.json
  info("Checking package.json...");
  if (!dryRun) stats.pkgUpdated = migratePackageJson(resolvedDir);
  else info("(dry-run) Would update package.json");

  // Step 2: Update babel configs
  info("Checking Babel config files...");
  if (!dryRun) stats.babelConfigs = migrateBabelConfig(resolvedDir);
  else info("(dry-run) Would update babel config");

  // Step 3: Optionally strip flow from source
  if (fullMode) {
    info("Scanning source files for Flow annotations...");
    const files = findFiles(resolvedDir);
    stats.scanned = files.length;
    info(`Found ${files.length} source files`);

    for (const file of files) {
      if (!dryRun) {
        const changed = stripFlowFromFile(file);
        if (changed) {
          stats.modified++;
          ok(`  stripped: ${path.relative(resolvedDir, file)}`);
        }
      }
    }
  }

  printReport(stats);
}

module.exports = { run };
