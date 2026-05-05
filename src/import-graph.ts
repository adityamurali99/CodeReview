import path from 'path';

export interface ImportGraph {
  // file -> set of files that import it
  reverse: Map<string, Set<string>>;
}

const IMPORT_REGEX =
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractRawImports(content: string): string[] {
  const imports: string[] = [];
  for (const regex of [IMPORT_REGEX, REQUIRE_REGEX]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const p = match[1];
      if (p) imports.push(p);
    }
  }
  return imports;
}

function resolveImport(
  importPath: string,
  fromFile: string,
  knownFiles: Set<string>
): string | null {
  if (!importPath.startsWith('.')) return null;

  const dir = path.posix.dirname(fromFile);
  const base = path.posix.join(dir, importPath);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];

  return candidates.find((c) => knownFiles.has(c)) ?? null;
}

export function buildImportGraph(fileContents: Map<string, string>): ImportGraph {
  const knownFiles = new Set(fileContents.keys());
  const reverse = new Map<string, Set<string>>();

  for (const [file, content] of fileContents) {
    const rawImports = extractRawImports(content);
    for (const raw of rawImports) {
      const resolved = resolveImport(raw, file, knownFiles);
      if (resolved === null) continue;

      if (!reverse.has(resolved)) reverse.set(resolved, new Set());
      reverse.get(resolved)!.add(file);
    }
  }

  return { reverse };
}

export function getAffectedFiles(
  changedFiles: string[],
  graph: ImportGraph
): Set<string> {
  const affected = new Set<string>();

  for (const file of changedFiles) {
    const importers = graph.reverse.get(file);
    if (importers) {
      for (const importer of importers) affected.add(importer);
    }
  }

  // remove changed files themselves — they're already being analyzed
  for (const f of changedFiles) affected.delete(f);

  return affected;
}
