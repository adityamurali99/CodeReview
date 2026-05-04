import { Octokit } from '@octokit/rest';
import { PRMetadata, ChangedFile } from './github';
import { Review, ReviewComment } from './reviewer';

// Parse the diff patch to find which line numbers in the new file are part of the diff.
// GitHub's review API only allows comments on lines present in the diff.
function getValidLines(files: ChangedFile[]): Map<string, Set<number>> {
  const validLines = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) continue;
    const lines = new Set<number>();
    let newLine = 0;

    for (const row of file.patch.split('\n')) {
      const hunkHeader = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkHeader) {
        newLine = parseInt(hunkHeader[1]!, 10) - 1;
        continue;
      }
      if (row.startsWith('-')) continue; // deleted line — no new-file line number
      newLine++;
      if (row.startsWith('+')) lines.add(newLine);
    }

    validLines.set(file.filename, lines);
  }

  return validLines;
}

export async function postReview(
  token: string,
  owner: string,
  repo: string,
  pr: PRMetadata,
  review: Review,
  changedFiles: ChangedFile[]
): Promise<void> {
  const octokit = new Octokit({ auth: token });
  const validLines = getValidLines(changedFiles);

  // Filter comments to only lines that exist in the diff
  const inlineComments = review.comments
    .filter((c) => {
      const lines = validLines.get(c.filename);
      return lines !== undefined && lines.has(c.line);
    })
    .map((c) => ({
      path: c.filename,
      line: c.line,
      body: formatCommentBody(c),
    }));

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

  console.log(
    `Posted review with ${inlineComments.length} inline comment(s) on PR #${pr.number}`
  );
}

function formatCommentBody(comment: ReviewComment): string {
  const badge: Record<ReviewComment['severity'], string> = {
    error: '🔴 **Error**',
    warning: '🟡 **Warning**',
    info: '🔵 **Info**',
  };
  return `${badge[comment.severity]}\n\n${comment.body}`;
}
