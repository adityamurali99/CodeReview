import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChangedFile } from './github';

export interface StaticIssue {
  filename: string;
  line: number;
  message: string;
  tool: 'eslint' | 'tsc';
  severity: 'error' | 'warning';
}

// Write changed files to a temp directory so we can run tools on them
function writeTempFiles(changedFiles: ChangedFile[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-'));
  for (const file of changedFiles) {
    if (file.newContent === null) continue;
    const dest = path.join(tmpDir, file.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.newContent, 'utf-8');
  }
  return tmpDir;
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runEslint(tmpDir: string, filenames: string[]): StaticIssue[] {
  const issues: StaticIssue[] = [];
  const targets = filenames
    .map((f) => path.join(tmpDir, f))
    .filter((f) => fs.existsSync(f));

  if (targets.length === 0) return issues;

  try {
    execSync(`npx eslint --format json ${targets.map((f) => `"${f}"`).join(' ')}`, {
      encoding: 'utf-8',
    });
  } catch (err: unknown) {
    // eslint exits with code 1 when it finds issues — the output is still valid JSON
    const output = getExecOutput(err);
    if (!output) return issues;

    try {
      const results = JSON.parse(output) as Array<{
        filePath: string;
        messages: Array<{ line: number; message: string; severity: number }>;
      }>;

      for (const result of results) {
        const filename = path.relative(tmpDir, result.filePath).replace(/\\/g, '/');
        for (const msg of result.messages) {
          issues.push({
            filename,
            line: msg.line,
            message: msg.message,
            tool: 'eslint',
            severity: msg.severity === 2 ? 'error' : 'warning',
          });
        }
      }
    } catch {
      // eslint output wasn't JSON — ignore
    }
  }

  return issues;
}

function runTsc(tmpDir: string): StaticIssue[] {
  const issues: StaticIssue[] = [];

  try {
    execSync(`npx tsc --noEmit --allowJs --checkJs false --strict false --baseUrl "${tmpDir}"`, {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
  } catch (err: unknown) {
    const output = getExecOutput(err);
    if (!output) return issues;

    // tsc output format: "file(line,col): error TSxxxx: message"
    const lineRegex = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
    let match;
    while ((match = lineRegex.exec(output)) !== null) {
      const [, filePath, line, severity, message] = match;
      if (!filePath || !line || !severity || !message) continue;
      issues.push({
        filename: path.relative(tmpDir, filePath).replace(/\\/g, '/'),
        line: parseInt(line, 10),
        message,
        tool: 'tsc',
        severity: severity === 'error' ? 'error' : 'warning',
      });
    }
  }

  return issues;
}

function getExecOutput(err: unknown): string | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    'stdout' in err &&
    typeof (err as { stdout: unknown }).stdout === 'string'
  ) {
    return (err as { stdout: string }).stdout;
  }
  return null;
}

export async function runStaticAnalysis(changedFiles: ChangedFile[]): Promise<StaticIssue[]> {
  const nonDeleted = changedFiles.filter((f) => f.status !== 'deleted' && f.newContent !== null);
  if (nonDeleted.length === 0) return [];

  const tmpDir = writeTempFiles(nonDeleted);

  try {
    const filenames = nonDeleted.map((f) => f.filename);
    const [eslintIssues, tscIssues] = await Promise.all([
      Promise.resolve(runEslint(tmpDir, filenames)),
      Promise.resolve(runTsc(tmpDir)),
    ]);
    return [...eslintIssues, ...tscIssues];
  } finally {
    cleanupTempDir(tmpDir);
  }
}
