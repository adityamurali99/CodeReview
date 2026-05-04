import { ChangedFile } from './github';
import { FunctionDef, GlobalDef } from './ast-parser';
import { AffectedFunctions } from './call-graph';

export interface AssembledContext {
  sections: ContextSection[];
  totalTokens: number;
}

export interface ContextSection {
  label: string;
  content: string;
  priority: number;
}

// Rough estimate: 1 token ≈ 4 characters
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatFunction(fn: FunctionDef, label: string): ContextSection {
  const content = [
    `// ${fn.file} — lines ${fn.startLine}-${fn.endLine}`,
    fn.body,
  ].join('\n');

  return { label, content, priority: 0 };
}

function formatChangedFile(file: ChangedFile): ContextSection {
  const lines: string[] = [`### ${file.filename} [${file.status}]`];

  if (file.patch) {
    lines.push('```diff', file.patch, '```');
  }

  return {
    label: `Changed file: ${file.filename}`,
    content: lines.join('\n'),
    priority: 0,
  };
}

function formatGlobal(g: GlobalDef): ContextSection {
  return {
    label: `Changed global: ${g.name}`,
    content: `// ${g.file} — line ${g.line}\n${g.body}`,
    priority: 0,
  };
}

export function assembleContext(
  changedFiles: ChangedFile[],
  affected: AffectedFunctions,
  changedGlobals: GlobalDef[] = [],
  globalReferencers: FunctionDef[] = [],
  TOKEN_BUDGET = 80_000
): AssembledContext {
  const sections: ContextSection[] = [];

  // Priority 1 — diffs of changed files
  for (const file of changedFiles) {
    sections.push({ ...formatChangedFile(file), priority: 1 });
  }

  // Priority 2 — changed globals and changed functions (equal priority)
  for (const g of changedGlobals) {
    sections.push({ ...formatGlobal(g), priority: 2 });
  }
  for (const fn of affected.changed) {
    sections.push({ ...formatFunction(fn, `Changed function: ${fn.name}`), priority: 2 });
  }

  // Priority 3 — direct callers + functions referencing changed globals
  for (const fn of affected.directCallers) {
    sections.push({ ...formatFunction(fn, `Direct caller: ${fn.name}`), priority: 3 });
  }
  for (const fn of globalReferencers) {
    sections.push({ ...formatFunction(fn, `References global: ${fn.name}`), priority: 3 });
  }

  // Priority 4 — secondary callers
  for (const fn of affected.secondaryCallers) {
    sections.push({ ...formatFunction(fn, `Secondary caller: ${fn.name}`), priority: 4 });
  }

  // Apply token budget: include all sections until budget is exhausted
  const included: ContextSection[] = [];
  let totalTokens = 0;

  for (const section of sections.sort((a, b) => a.priority - b.priority)) {
    const tokens = estimateTokens(section.content);
    if (totalTokens + tokens > TOKEN_BUDGET) break;
    included.push(section);
    totalTokens += tokens;
  }

  return { sections: included, totalTokens };
}

export function renderContext(context: AssembledContext): string {
  return context.sections
    .map((s) => `## ${s.label}\n${s.content}`)
    .join('\n\n---\n\n');
}
