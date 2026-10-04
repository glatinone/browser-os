// Package boundary checker (CODING_AGENT.md §7).
//
// Fails `pnpm lint` when a package imports something it must not: an internal
// package outside its allowed set, an external runtime dependency that is not
// approved for it, a deep import into another package's source, or a relative
// import that escapes its own package root.
//
// The allowed sets below mirror CODING_AGENT.md §6-§7 exactly. A change here
// means the document changed first.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Allowed internal dependencies per package. `protocol` is the root of the graph. */
export const INTERNAL_DEPS = {
  protocol: [],
  dom: ['protocol'],
  ai: ['protocol'],
  memory: ['protocol'],
  browser: ['protocol'],
  runtime: ['protocol', 'dom', 'ai', 'memory', 'browser'],
  daemon: ['protocol', 'runtime'],
  sdk: ['protocol'],
  cli: ['protocol', 'sdk'],
};

/** Allowed external runtime dependencies per package. `node:*` is always allowed. */
export const EXTERNAL_DEPS = {
  protocol: ['zod'],
  dom: ['zod'],
  ai: ['zod'],
  memory: ['better-sqlite3', 'zod'],
  browser: ['playwright-core', 'zod'],
  runtime: ['zod'],
  daemon: ['ws', 'zod'],
  sdk: ['ws', 'zod'],
  cli: ['zod'],
};

/**
 * Declarations that are allowed in `package.json` but must never be imported
 * from `src/`: @browser-os/cli ships the daemon binary (integration §14).
 */
export const DECLARATION_ONLY_DEPS = {
  cli: ['@browser-os/daemon'],
};

const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import/export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import 'x'
];

function isDirectory(entry) {
  return entry.isDirectory();
}

function listPackageNames(packagesDir) {
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(isDirectory)
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(path.join(packagesDir, name, 'package.json'), 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function listFilesRecursively(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(full));
    else files.push(full);
  }
  return files;
}

/** `@scope/name/sub` -> `@scope/name`; `ws/lib/x` -> `ws`; `lodash` -> `lodash`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function relative(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

function scanSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      if (match[1]) found.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...found];
}

function checkDeclarations(rootDir, pkg, pkgDir, violations) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    violations.push({
      file: relative(rootDir, pkgJsonPath),
      pkg,
      specifier: pkgJsonPath,
      kind: 'unreadable',
      message: `${relative(rootDir, pkgJsonPath)}: unreadable package.json`,
    });
    return;
  }
  const internalAllowed = new Set((INTERNAL_DEPS[pkg] ?? []).map((d) => `@browser-os/${d}`));
  const externalAllowed = new Set(EXTERNAL_DEPS[pkg] ?? []);
  const declarationOnly = new Set(DECLARATION_ONLY_DEPS[pkg] ?? []);
  const declared = Object.keys(manifest.dependencies ?? {});

  for (const dep of declared) {
    const allowed = dep.startsWith('@browser-os/')
      ? internalAllowed.has(dep) || declarationOnly.has(dep)
      : externalAllowed.has(dep);
    if (!allowed) {
      violations.push({
        file: relative(rootDir, pkgJsonPath),
        pkg,
        specifier: dep,
        kind: 'declaration',
        message: `${relative(rootDir, pkgJsonPath)}: declares dependency '${dep}' (not allowed in ${pkg})`,
      });
    }
  }
}

function checkSourceFile(rootDir, pkg, pkgDir, file, violations) {
  const source = readFileSync(file, 'utf8');
  const from = relative(rootDir, file);
  const internalAllowed = new Set((INTERNAL_DEPS[pkg] ?? []).map((d) => `@browser-os/${d}`));
  const externalAllowed = new Set(EXTERNAL_DEPS[pkg] ?? []);

  for (const specifier of scanSpecifiers(source)) {
    if (specifier.startsWith('node:')) continue;

    if (specifier.startsWith('@browser-os/')) {
      const name = packageNameOf(specifier);
      if (specifier !== name) {
        violations.push({
          file: from,
          pkg,
          specifier,
          kind: 'deep-import',
          message: `${from}: deep import '${specifier}' (not allowed in ${pkg})`,
        });
      } else if (!internalAllowed.has(name)) {
        violations.push({
          file: from,
          pkg,
          specifier,
          kind: 'internal',
          message: `${from}: imports '${specifier}' (not allowed in ${pkg})`,
        });
      }
      continue;
    }

    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const insidePackage = resolved === pkgDir || resolved.startsWith(pkgDir + path.sep);
      if (!insidePackage) {
        violations.push({
          file: from,
          pkg,
          specifier,
          kind: 'relative-escape',
          message: `${from}: relative import '${specifier}' escapes packages/${pkg}`,
        });
      }
      continue;
    }

    if (!externalAllowed.has(packageNameOf(specifier))) {
      violations.push({
        file: from,
        pkg,
        specifier,
        kind: 'external',
        message: `${from}: imports '${specifier}' (not allowed in ${pkg})`,
      });
    }
  }
}

/** Returns every boundary violation in the tree rooted at `rootDir`. */
export function checkBoundaries(rootDir) {
  const violations = [];
  const packagesDir = path.join(rootDir, 'packages');
  for (const pkg of listPackageNames(packagesDir)) {
    const pkgDir = path.join(packagesDir, pkg);
    checkDeclarations(rootDir, pkg, pkgDir, violations);
    for (const file of listFilesRecursively(path.join(pkgDir, 'src'))) {
      if (file.endsWith('.ts')) checkSourceFile(rootDir, pkg, pkgDir, file, violations);
    }
  }
  return violations;
}

function main() {
  const rootDir = process.cwd();
  const violations = checkBoundaries(rootDir);
  for (const violation of violations) console.error(violation.message);
  if (violations.length > 0) {
    console.error(`\n${violations.length} package boundary violation(s). See CODING_AGENT.md §7.`);
    process.exitCode = 1;
    return;
  }
  console.log('package boundaries OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
