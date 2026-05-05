import ts from 'typescript';

export interface FunctionDef {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  body: string;
  parameters: string;
  returnType: string;
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function resolveName(node: FunctionNode): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }

  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    const className = findParentClassName(node);
    return className ? `${className}.${node.name.text}` : node.name.text;
  }

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  return '(anonymous)';
}

function findParentClassName(node: ts.Node): string | null {
  let current: ts.Node = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function visitFunctionNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filename: string,
  functions: FunctionDef[]
): void {
  if (isFunctionNode(node)) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    functions.push({
      name: resolveName(node),
      file: filename,
      startLine: start.line + 1,
      endLine: end.line + 1,
      body: node.getText(sourceFile),
      parameters: node.parameters.map((p) => p.getText(sourceFile)).join(', '),
      returnType: node.type ? node.type.getText(sourceFile) : '',
    });
  }
  ts.forEachChild(node, (child) => visitFunctionNode(child, sourceFile, filename, functions));
}

export function parseFunctions(filename: string, content: string): FunctionDef[] {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  const functions: FunctionDef[] = [];
  visitFunctionNode(sourceFile, sourceFile, filename, functions);
  return functions;
}

export function getFunctionsInRange(
  functions: FunctionDef[],
  filename: string,
  changedLines: Set<number>
): FunctionDef[] {
  return functions.filter(
    (fn) =>
      fn.file === filename &&
      [...changedLines].some((line) => line >= fn.startLine && line <= fn.endLine)
  );
}

export interface GlobalDef {
  name: string;
  file: string;
  line: number;
  body: string;
}

export function parseGlobals(filename: string, content: string): GlobalDef[] {
  const sourceFile = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  const globals: GlobalDef[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const line =
        sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
      globals.push({
        name: decl.name.text,
        file: filename,
        line,
        body: statement.getText(sourceFile),
      });
    }
  }

  return globals;
}

export function getGlobalsInRange(
  globals: GlobalDef[],
  filename: string,
  changedLines: Set<number>
): GlobalDef[] {
  return globals.filter((g) => g.file === filename && changedLines.has(g.line));
}
