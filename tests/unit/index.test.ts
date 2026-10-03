import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENTRY_PATH = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

const isNodeEnvDefault = (stmt: ts.Statement): boolean => {
  if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) return false;
  const { left, operatorToken } = stmt.expression;
  return (
    operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
    ts.isPropertyAccessExpression(left) &&
    left.getText() === 'process.env.NODE_ENV'
  );
};

const isTypeOnly = (stmt: ts.Statement): boolean =>
  (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly === true) ||
  (ts.isExportDeclaration(stmt) && stmt.isTypeOnly);

/** Ordering violations in an entry module's source; empty when NODE_ENV is set before any app code can load. */
const entryOrderViolations = (source: string): string[] => {
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  for (const stmt of file.statements) {
    const specifier =
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : undefined;
    if (specifier !== undefined && !isTypeOnly(stmt) && !specifier.startsWith('node:')) {
      violations.push(`static import of '${specifier}'`);
    }
  }
  const first = file.statements.find((stmt) => !isTypeOnly(stmt));
  if (first === undefined || !isNodeEnvDefault(first)) {
    violations.push("first statement is not `process.env.NODE_ENV ??= 'production'`");
  }
  return violations;
};

describe('src/index.ts entry order', () => {
  it('sets NODE_ENV before anything else and loads app code only through dynamic import()', () => {
    expect(entryOrderViolations(readFileSync(ENTRY_PATH, 'utf8'))).toEqual([]);
  });

  it('flags a static import of app code', () => {
    const source = [
      "process.env.NODE_ENV ??= 'production';",
      "import { runCli } from '@src/application/ui/cli/cli.ts';",
    ].join('\n');
    expect(entryOrderViolations(source)).toEqual(["static import of '@src/application/ui/cli/cli.ts'"]);
  });

  it('flags a re-export, since it evaluates the module too', () => {
    const source = ["process.env.NODE_ENV ??= 'production';", "export * from 'ink';"].join('\n');
    expect(entryOrderViolations(source)).toEqual(["static import of 'ink'"]);
  });

  it('flags a NODE_ENV assignment that is no longer the first statement', () => {
    const source = [
      "const { runCli } = await import('@src/application/ui/cli/cli.ts');",
      "process.env.NODE_ENV ??= 'production';",
    ].join('\n');
    expect(entryOrderViolations(source)).toEqual(["first statement is not `process.env.NODE_ENV ??= 'production'`"]);
  });

  it('allows type-only and node: builtin imports, which cannot load React', () => {
    const source = [
      "import type { Command } from 'commander';",
      "process.env.NODE_ENV ??= 'production';",
      "import { argv } from 'node:process';",
    ].join('\n');
    expect(entryOrderViolations(source)).toEqual([]);
  });
});
