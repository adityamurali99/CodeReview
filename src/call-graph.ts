import ts from 'typescript';
import { FunctionDef, GlobalDef } from './ast-parser';

export interface CallGraph {
  // callee name -> set of FunctionDefs that call it
  callers: Map<string, Set<FunctionDef>>;
}

export interface AffectedFunctions {
  changed: FunctionDef[];
  directCallers: FunctionDef[];
  secondaryCallers: FunctionDef[];
}

function visitCallNode(node: ts.Node, calls: Set<string>): void {
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      calls.add(expr.text);
    } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
      calls.add(expr.name.text);
    }
  }
  ts.forEachChild(node, (child) => visitCallNode(child, calls));
}

function extractCallNames(body: string): string[] {
  const sourceFile = ts.createSourceFile('temp.ts', body, ts.ScriptTarget.Latest, true);
  const calls = new Set<string>();
  visitCallNode(sourceFile, calls);
  return [...calls];
}

export function buildCallGraph(allFunctions: FunctionDef[]): CallGraph {
  const callers = new Map<string, Set<FunctionDef>>();

  for (const fn of allFunctions) {
    for (const callee of extractCallNames(fn.body)) {
      if (!callers.has(callee)) callers.set(callee, new Set());
      callers.get(callee)!.add(fn);
    }
  }

  return { callers };
}

export function getAffectedFunctions(
  changedFunctions: FunctionDef[],
  graph: CallGraph
): AffectedFunctions {
  const changedNames = new Set(changedFunctions.map((f) => f.name));
  const directCallers: FunctionDef[] = [];
  const directCallerNames = new Set<string>();

  for (const name of changedNames) {
    for (const caller of graph.callers.get(name) ?? []) {
      if (!changedNames.has(caller.name)) {
        directCallers.push(caller);
        directCallerNames.add(caller.name);
      }
    }
  }

  const secondaryCallers: FunctionDef[] = [];
  const seen = new Set<string>([...changedNames, ...directCallerNames]);

  for (const name of directCallerNames) {
    for (const caller of graph.callers.get(name) ?? []) {
      if (!seen.has(caller.name)) {
        secondaryCallers.push(caller);
        seen.add(caller.name);
      }
    }
  }

  return { changed: changedFunctions, directCallers, secondaryCallers };
}

// Walks the AST of a node looking for any reference to globalName
function nodeReferencesGlobal(node: ts.Node, globalName: string): boolean {
  if (ts.isIdentifier(node) && node.text === globalName) {
    const parent = node.parent;
    // Skip the declaration itself — we only care about usages
    if (!(ts.isVariableDeclaration(parent) && parent.name === node)) return true;
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = nodeReferencesGlobal(child, globalName);
  });
  return found;
}

export function getGlobalReferencingFunctions(
  changedGlobals: GlobalDef[],
  allFunctions: FunctionDef[]
): FunctionDef[] {
  const result: FunctionDef[] = [];
  const seen = new Set<string>();

  for (const global of changedGlobals) {
    for (const fn of allFunctions) {
      if (seen.has(fn.name)) continue;
      const sourceFile = ts.createSourceFile('temp.ts', fn.body, ts.ScriptTarget.Latest, true);
      if (nodeReferencesGlobal(sourceFile, global.name)) {
        result.push(fn);
        seen.add(fn.name);
      }
    }
  }

  return result;
}
