import ts from 'typescript';
import { FunctionDef, GlobalDef } from './ast-parser';

export interface CallGraph {
  // callee name -> set of FunctionDefs that call it
  callers: Map<string, Set<FunctionDef>>;
  // caller name -> set of callee names it calls
  callees: Map<string, Set<string>>;
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
  const callees = new Map<string, Set<string>>();

  for (const fn of allFunctions) {
    const called = extractCallNames(fn.body);
    callees.set(fn.name, new Set(called));

    for (const callee of called) {
      if (!callers.has(callee)) callers.set(callee, new Set());
      callers.get(callee)!.add(fn);
    }
  }

  return { callers, callees };
}

export interface AffectedFunctions {
  changed: FunctionDef[];
  directCallers: FunctionDef[];
  secondaryCallers: FunctionDef[];
}

export function getAffectedFunctions(
  changedFunctions: FunctionDef[],
  graph: CallGraph
): AffectedFunctions {
  const changedNames = new Set(changedFunctions.map((f) => f.name));

  const directCallers: FunctionDef[] = [];
  const directCallerNames = new Set<string>();

  for (const name of changedNames) {
    const callerSet = graph.callers.get(name);
    if (!callerSet) continue;
    for (const caller of callerSet) {
      if (!changedNames.has(caller.name)) {
        directCallers.push(caller);
        directCallerNames.add(caller.name);
      }
    }
  }

  const secondaryCallers: FunctionDef[] = [];
  const seen = new Set<string>([...changedNames, ...directCallerNames]);

  for (const name of directCallerNames) {
    const callerSet = graph.callers.get(name);
    if (!callerSet) continue;
    for (const caller of callerSet) {
      if (!seen.has(caller.name)) {
        secondaryCallers.push(caller);
        seen.add(caller.name);
      }
    }
  }

  return { changed: changedFunctions, directCallers, secondaryCallers };
}

function nodeReferencesGlobal(node: ts.Node, globalName: string): boolean {
  if (ts.isIdentifier(node) && node.text === globalName) {
    const parent = node.parent;
    if (!(ts.isVariableDeclaration(parent) && parent.name === node)) {
      return true;
    }
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = nodeReferencesGlobal(child, globalName);
  });
  return found;
}

function functionReferencesGlobal(fn: FunctionDef, globalName: string): boolean {
  const sourceFile = ts.createSourceFile('temp.ts', fn.body, ts.ScriptTarget.Latest, true);
  return nodeReferencesGlobal(sourceFile, globalName);
}

export function getGlobalReferencingFunctions(
  changedGlobals: GlobalDef[],
  allFunctions: FunctionDef[]
): FunctionDef[] {
  const result: FunctionDef[] = [];
  const seen = new Set<string>();

  for (const global of changedGlobals) {
    for (const fn of allFunctions) {
      if (!seen.has(fn.name) && functionReferencesGlobal(fn, global.name)) {
        result.push(fn);
        seen.add(fn.name);
      }
    }
  }

  return result;
}
