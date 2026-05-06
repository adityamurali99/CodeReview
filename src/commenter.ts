import { Octokit } from '@octokit/rest';
import { PRMetadata, ChangedFile } from './github';
import { Review, ReviewComment } from './reviewer';
import { parsePatchLines } from './diff';

// Maps each changed file to the set of line numbers present in the diff.
// GitHub only allows review comments on lines that appear in the diff.
function buildValidLinesMap(files: ChangedFile[]): Map<string, Set<number>> {
  const validLines = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) validLines.set(file.filename, parsePatchLines(file.patch));
  }
  return validLines;
}

function isCommentOnValidLine(
  comment: ReviewComment,
  validLines: Map<string, Set<number>>
): boolean {
  return validLines.get(comment.filename)?.has(comment.line) ?? false;
}

function formatCommentBody(comment: ReviewComment): string {
  const badge: Record<ReviewComment['severity'], string> = {
    error: '🔴 **Error**',
    warning: '🟡 **Warning**',
    info: '🔵 **Info**',
  };
  return `${badge[comment.severity]}\n\n${comment.body}`;
}

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PRMetadata,
  review: Review,
  changedFiles: ChangedFile[]
): Promise<void> {
  const validLines = buildValidLinesMap(changedFiles);

  const inlineComments = review.comments
    .filter((c) => isCommentOnValidLine(c, validLines))
    .map((c) => ({ path: c.filename, line: c.line, body: formatCommentBody(c) }));

  const skipped = review.comments.length - inlineComments.length;
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} comment(s) targeting lines not in the diff`);
  }

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pr.number,
    commit_id: pr.headSha,
    body: review.summary,
    event: 'COMMENT',
    comments: inlineComments,
  });

  console.log(`Posted review with ${inlineComments.length} inline comment(s) on PR #${pr.number}`);
}
