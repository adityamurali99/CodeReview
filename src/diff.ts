// Parses a unified diff patch and returns the set of line numbers
// that exist in the new version of the file (i.e. added or context lines).
// Deleted lines are skipped since they have no line number in the new file.
export function parsePatchLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let currentLine = 0;

  for (const row of patch.split('\n')) {
    const hunkHeader = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      currentLine = parseInt(hunkHeader[1]!, 10) - 1;
      continue;
    }
    if (row.startsWith('-')) continue;
    currentLine++;
    if (row.startsWith('+')) lines.add(currentLine);
  }

  return lines;
}
