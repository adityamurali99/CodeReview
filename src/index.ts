#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { GitHubClient } from './github';
import { buildImportGraph, getAffectedFiles } from './import-graph';
import { parseFunctions, getFunctionsInRange, parseGlobals, getGlobalsInRange } from './ast-parser';
import { buildCallGraph, getAffectedFunctions, getGlobalReferencingFunctions } from './call-graph';
import { assembleContext } from './context-builder';
import { runStaticAnalysis } from './static-analysis';
import { getReview } from './reviewer';
import { judgeReview } from './judge';
import { postReview } from './commenter';
import { parsePatchLines } from './diff';
import { initLogger, log } from './logger';

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
  .option('--debug', 'Enable verbose debug logging', false)
  .action(async (options) => {
    initLogger(options.debug as boolean);

    const env = EnvSchema.safeParse(process.env);
    if (!env.success) {
      env.error.issues.forEach((i) =>
        log().error({ field: i.path.join('.') }, `Missing env var: ${i.message}`)
      );
      process.exit(1);
    }

    const { GITHUB_TOKEN, ANTHROPIC_API_KEY } = env.data;
    const { owner, repo, pr: prNumber } = options;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const github = new GitHubClient(octokit, owner, repo);

    log().info({ owner, repo, prNumber }, `Reviewing PR #${prNumber} on ${owner}/${repo}`);

    try {
      // [1/8] Fetch PR metadata and the list of changed files with their diffs
      log().info('Fetching PR metadata and changed files...');
      const pr = await github.getPRMetadata(prNumber);
      const changedFiles = await github.getChangedFiles(pr);
      log().info({ title: pr.title, fileCount: changedFiles.length }, '[1/8] PR fetched');

      // [2/8] Fetch all TS/JS files in the repo and build a reverse import map
      log().info('Building import graph...');
      const fileTree = await github.getFileTree(pr.headSha);
      const tsFiles = fileTree.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
      const allFileContents = await github.batchGetFileContents(tsFiles, pr.headSha);
      const importGraph = buildImportGraph(allFileContents);
      const changedFilenames = changedFiles.map((f) => f.filename);
      const affectedFilenames = getAffectedFiles(changedFilenames, importGraph);
      log().info({ affectedCount: affectedFilenames.size }, '[2/8] Import graph built');

      // [3/8] Parse functions and globals from changed + affected files only
      log().info('Parsing AST...');
      const filesToParse = [...changedFilenames, ...affectedFilenames];
      const allFunctions = filesToParse.flatMap((filename) => {
        const content = allFileContents.get(filename);
        return content ? parseFunctions(filename, content) : [];
      });
      const allGlobals = filesToParse.flatMap((filename) => {
        const content = allFileContents.get(filename);
        return content ? parseGlobals(filename, content) : [];
      });
      log().info({ functionCount: allFunctions.length, globalCount: allGlobals.length }, '[3/8] AST parsed');

      // [4/8] Build call graph and identify which functions and globals were touched
      log().info('Building call graph...');
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

      // Warn about changed files whose diffs touch no known function — often new files or top-level code
      const parsedFilenames = new Set(changedFunctions.map((fn) => fn.file));
      const unmatchedFiles = changedFiles.filter(
        (f) => f.patch && !parsedFilenames.has(f.filename)
      );
      if (unmatchedFiles.length > 0) {
        log().debug(
          { files: unmatchedFiles.map((f) => f.filename) },
          'changed files with no matched functions (new files or top-level code)'
        );
      }

      log().info(
        {
          changedFunctions: changedFunctions.length,
          changedGlobals: changedGlobals.length,
          directCallers: affectedFunctions.directCallers.length,
          globalReferencers: globalReferencers.length,
        },
        '[4/8] Call graph built'
      );

      // [5/8] Assemble priority-ordered context within the token budget
      log().info('Assembling context...');
      const context = assembleContext(changedFiles, affectedFunctions, changedGlobals, globalReferencers);
      log().info({ totalTokens: context.totalTokens }, '[5/8] Context assembled');

      // [6/8] Run eslint and tsc on changed files to surface confirmed issues
      log().info('Running static analysis...');
      const staticIssues = await runStaticAnalysis(changedFiles);
      log().info({ issueCount: staticIssues.length }, '[6/8] Static analysis complete');

      // [7/8] Send context to Claude and get structured inline comments
      log().info('Calling Claude for review...');
      const review = await getReview(anthropic, pr, context, staticIssues);
      log().info({ commentCount: review.comments.length }, '[7/8] Review generated');

      // [8/8] Filter out false positives using a second Claude call as judge
      log().info('Judging comments...');
      const validatedComments = await judgeReview(anthropic, pr, review.comments, context);
      log().info(
        { passed: validatedComments.length, total: review.comments.length },
        '[8/8] Judging complete'
      );

      log().info('Posting review to GitHub...');
      await postReview(octokit, owner, repo, pr, { ...review, comments: validatedComments }, changedFiles);
    } catch (err) {
      log().error({ err }, 'Review failed');
      process.exit(1);
    }
  });

program.parse();
