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

function writeTempFiles(files: ChangedFile[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-'));
  for (const file of files) {
    if (file.newContent === null) continue;
    const dest = path.join(tmpDir, file.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.newContent, 'utf-8');
  }
  return tmpDir;
}

// execSync throws on non-zero exit codes — this extracts stdout from the error object
function getStdout(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'stdout' in err) {
    const stdout = (err as { stdout: unknown }).stdout;
    if (typeof stdout === 'string') return stdout;
  }
  return null;
}

function runEslint(tmpDir: string, filenames: string[]): StaticIssue[] {
  const targets = filenames
    .map((f) => path.join(tmpDir, f))
    .filter((f) => fs.existsSync(f));

  if (targets.length === 0) return [];

  try {
    execSync(`npx eslint --format json ${targets.map((f) => `"${f}"`).join(' ')}`, {
      encoding: 'utf-8',
    });
    return [];
  } catch (err) {
    // eslint exits with code 1 when it finds issues — stdout is still valid JSON
    const stdout = getStdout(err);
    if (!stdout) return [];

    try {
      type EslintResult = {
        filePath: string;
        messages: Array<{ line: number; message: string; severity: number }>;
      };

      return (JSON.parse(stdout) as EslintResult[]).flatMap((result) => {
        const filename = path.relative(tmpDir, result.filePath).replace(/\\/g, '/');
        return result.messages.map((msg) => ({
          filename,
          line: msg.line,
          message: msg.message,
          tool: 'eslint' as const,
          severity: msg.severity === 2 ? ('error' as const) : ('warning' as const),
        }));
      });
    } catch {
      return [];
    }
  }
}

function runTsc(tmpDir: string): StaticIssue[] {
  try {
    execSync(`npx tsc --noEmit --allowJs --checkJs false --strict false --baseUrl "${tmpDir}"`, {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    return [];
  } catch (err) {
    const stdout = getStdout(err);
    if (!stdout) return [];

    // tsc output format: "file(line,col): error TSxxxx: message"
    const issues: StaticIssue[] = [];
    const linePattern = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
    let match;

    while ((match = linePattern.exec(stdout)) !== null) {
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

    return issues;
  }
}

export async function runStaticAnalysis(changedFiles: ChangedFile[]): Promise<StaticIssue[]> {
  const filesToAnalyze = changedFiles.filter(
    (f) => f.status !== 'deleted' && f.newContent !== null
  );
  if (filesToAnalyze.length === 0) return [];

  const tmpDir = writeTempFiles(filesToAnalyze);

  try {
    const filenames = filesToAnalyze.map((f) => f.filename);
    return [...runEslint(tmpDir, filenames), ...runTsc(tmpDir)];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
