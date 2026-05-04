#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { z } from 'zod';
import { GitHubClient } from './github';
import { buildImportGraph, getAffectedFiles } from './import-graph';
import { parseFunctions, getFunctionsInRange, parseGlobals, getGlobalsInRange } from './ast-parser';
import { buildCallGraph, getAffectedFunctions, getGlobalReferencingFunctions } from './call-graph';
import { assembleContext } from './context-builder';
import { runStaticAnalysis } from './static-analysis';
import { getReview } from './reviewer';
import { postReview } from './commenter';

const EnvSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
});

const program = new Command();

program
  .name('review')
  .description('AI-powered code review agent')
  .requiredOption('--owner <owner>', 'GitHub repository owner')
  .requiredOption('--repo <repo>', 'GitHub repository name')
  .requiredOption('--pr <number>', 'Pull request number', (val) => {
    const n = parseInt(val, 10);
    if (isNaN(n) || n <= 0) throw new Error('PR number must be a positive integer');
    return n;
  })
  .action(async (options) => {
    const env = EnvSchema.safeParse(process.env);
    if (!env.success) {
      console.error('Missing required environment variables:');
      env.error.issues.forEach((i) => console.error(` - ${i.path.join('.')}: ${i.message}`));
      process.exit(1);
    }

    const { GITHUB_TOKEN, ANTHROPIC_API_KEY } = env.data;
    const { owner, repo, pr: prNumber } = options;

    console.log(`\nReviewing PR #${prNumber} on ${owner}/${repo}...\n`);

    // Phase 2: Fetch PR data from GitHub
    console.log('[1/7] Fetching PR metadata and changed files...');
    const github = new GitHubClient(GITHUB_TOKEN, owner, repo);
    const pr = await github.getPRMetadata(prNumber);
    const changedFiles = await github.getChangedFiles(pr);
    console.log(`      PR: "${pr.title}"`);
    console.log(`      ${changedFiles.length} changed file(s)`);

    // Phase 3: Build import graph over the entire repo (TS/JS files only)
    console.log('[2/7] Building import graph...');
    const fileTree = await github.getFileTree(pr.headSha);
    const tsFiles = fileTree.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
    const allContents = await github.batchGetFileContents(tsFiles, pr.headSha);
    const importGraph = buildImportGraph(allContents);
    const changedFilenames = changedFiles.map((f) => f.filename);
    const affectedFilenames = getAffectedFiles(changedFilenames, importGraph);
    console.log(`      ${affectedFilenames.size} file(s) affected via imports`);

    // Phase 4: Parse AST for changed + affected files only
    console.log('[3/7] Parsing AST...');
    const filesToParse = [...changedFilenames, ...affectedFilenames];
    const allFunctions = filesToParse.flatMap((filename) => {
      const content = allContents.get(filename);
      return content ? parseFunctions(filename, content) : [];
    });
    const allGlobals = filesToParse.flatMap((filename) => {
      const content = allContents.get(filename);
      return content ? parseGlobals(filename, content) : [];
    });
    console.log(`      ${allFunctions.length} function(s) and ${allGlobals.length} global(s) indexed`);

    // Phase 5: Build call graph and find affected functions + globals
    console.log('[4/7] Building call graph...');
    const callGraph = buildCallGraph(allFunctions);
    const changedFunctions = changedFiles.flatMap((file) => {
      if (!file.patch) return [];
      const changedLines = parsePatchLines(file.patch);
      return getFunctionsInRange(allFunctions, file.filename, changedLines);
    });
    const changedGlobals = changedFiles.flatMap((file) => {
      if (!file.patch) return [];
      const changedLines = parsePatchLines(file.patch);
      return getGlobalsInRange(allGlobals, file.filename, changedLines);
    });
    const affectedFunctions = getAffectedFunctions(changedFunctions, callGraph);
    const globalReferencers = getGlobalReferencingFunctions(changedGlobals, allFunctions);
    console.log(
      `      ${changedFunctions.length} changed function(s), ` +
        `${changedGlobals.length} changed global(s), ` +
        `${affectedFunctions.directCallers.length} direct caller(s), ` +
        `${globalReferencers.length} global referencer(s)`
    );

    // Phase 6: Assemble context within token budget
    console.log('[5/7] Assembling context...');
    const context = assembleContext(changedFiles, affectedFunctions, changedGlobals, globalReferencers);
    console.log(`      ~${context.totalTokens.toLocaleString()} tokens assembled`);

    // Phase 7: Run static analysis on changed files
    console.log('[6/7] Running static analysis...');
    const staticIssues = await runStaticAnalysis(changedFiles);
    console.log(`      ${staticIssues.length} static issue(s) found`);

    // Phase 8: Call Claude for the review
    console.log('[7/7] Calling Claude for review...');
    const review = await getReview(ANTHROPIC_API_KEY, pr, context, staticIssues);
    console.log(`      ${review.comments.length} comment(s) generated`);

    // Post review to GitHub
    console.log('\nPosting review to GitHub...');
    await postReview(GITHUB_TOKEN, owner, repo, pr, review, changedFiles);
  });

program.parse();

// Extract all new-file line numbers touched by a diff patch
function parsePatchLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;

  for (const row of patch.split('\n')) {
    const hunkHeader = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      newLine = parseInt(hunkHeader[1]!, 10) - 1;
      continue;
    }
    if (row.startsWith('-')) continue;
    newLine++;
    if (row.startsWith('+')) lines.add(newLine);
  }

  return lines;
}
