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

function changedFileSection(file: ChangedFile, priority: number): ContextSection {
  const lines = [`### ${file.filename} [${file.status}]`];
  if (file.patch) lines.push('```diff', file.patch, '```');
  return { label: `Changed file: ${file.filename}`, content: lines.join('\n'), priority };
}

function functionSection(fn: FunctionDef, label: string, priority: number): ContextSection {
  const content = `// ${fn.file} — lines ${fn.startLine}-${fn.endLine}\n${fn.body}`;
  return { label, content, priority };
}

function globalSection(g: GlobalDef, priority: number): ContextSection {
  return {
    label: `Changed global: ${g.name}`,
    content: `// ${g.file} — line ${g.line}\n${g.body}`,
    priority,
  };
}

export function assembleContext(
  changedFiles: ChangedFile[],
  affected: AffectedFunctions,
  changedGlobals: GlobalDef[] = [],
  globalReferencers: FunctionDef[] = [],
  tokenBudget = 80_000
): AssembledContext {
  const sections: ContextSection[] = [
    ...changedFiles.map((f) => changedFileSection(f, 1)),
    ...changedGlobals.map((g) => globalSection(g, 2)),
    ...affected.changed.map((fn) => functionSection(fn, `Changed function: ${fn.name}`, 2)),
    ...affected.directCallers.map((fn) => functionSection(fn, `Direct caller: ${fn.name}`, 3)),
    ...globalReferencers.map((fn) => functionSection(fn, `References global: ${fn.name}`, 3)),
    ...affected.secondaryCallers.map((fn) => functionSection(fn, `Secondary caller: ${fn.name}`, 4)),
  ];

  sections.sort((a, b) => a.priority - b.priority);

  const included: ContextSection[] = [];
  let totalTokens = 0;

  for (const section of sections) {
    const tokens = estimateTokens(section.content);
    if (totalTokens + tokens > tokenBudget) break;
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
