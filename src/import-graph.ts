import path from 'path';

export interface ImportGraph {
  // file -> set of files that import it
  reverse: Map<string, Set<string>>;
}

const IMPORT_REGEX = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImportPaths(content: string): string[] {
  const imports: string[] = [];

  for (const regex of [IMPORT_REGEX, REQUIRE_REGEX]) {
    // Reset lastIndex since these are module-level regexes with the /g flag
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath) imports.push(importPath);
    }
  }

  return imports;
}

function resolveImportPath(
  importPath: string,
  fromFile: string,
  knownFiles: Set<string>
): string | null {
  // Only resolve relative imports — external packages are not in the repo
  if (!importPath.startsWith('.')) return null;

  const dir = path.posix.dirname(fromFile);
  const resolvedBase = path.posix.join(dir, importPath);

  const candidates = [
    resolvedBase,
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.js`,
    `${resolvedBase}.jsx`,
    `${resolvedBase}/index.ts`,
    `${resolvedBase}/index.tsx`,
    `${resolvedBase}/index.js`,
  ];

  return candidates.find((c) => knownFiles.has(c)) ?? null;
}

export function buildImportGraph(fileContents: Map<string, string>): ImportGraph {
  const knownFiles = new Set(fileContents.keys());
  const reverse = new Map<string, Set<string>>();

  for (const [file, content] of fileContents) {
    for (const rawImport of extractImportPaths(content)) {
      const resolvedPath = resolveImportPath(rawImport, file, knownFiles);
      if (resolvedPath === null) continue;

      if (!reverse.has(resolvedPath)) reverse.set(resolvedPath, new Set());
      reverse.get(resolvedPath)!.add(file);
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

  // Exclude the changed files themselves — they are already being analyzed
  for (const file of changedFiles) affected.delete(file);

  return affected;
}
