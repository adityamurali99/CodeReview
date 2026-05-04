import Anthropic from '@anthropic-ai/sdk';
import { PRMetadata } from './github';
import { AssembledContext, renderContext } from './context-builder';
import { StaticIssue } from './static-analysis';

export interface ReviewComment {
  filename: string;
  line: number;
  body: string;
  severity: 'info' | 'warning' | 'error';
}

export interface Review {
  summary: string;
  comments: ReviewComment[];
}

const MODEL = 'claude-sonnet-4-6';

const REVIEW_TOOL: Anthropic.Tool = {
  name: 'submit_review',
  description: 'Submit a structured code review with inline comments and an overall summary.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Overall assessment of the PR: what it does, risks, and a recommendation.',
      },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'File path relative to repo root.' },
            line: { type: 'number', description: 'Line number in the new version of the file.' },
            body: { type: 'string', description: 'Review comment explaining the issue and how to fix it.' },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'error'],
              description: 'info = suggestion, warning = should fix, error = must fix.',
            },
          },
          required: ['filename', 'line', 'body', 'severity'],
        },
      },
    },
    required: ['summary', 'comments'],
  },
};

function buildPrompt(pr: PRMetadata, context: AssembledContext, issues: StaticIssue[]): string {
  const parts: string[] = [
    `# Pull Request #${pr.number}: ${pr.title}`,
  ];

  if (pr.description) {
    parts.push(`## Description\n${pr.description}`);
  }

  parts.push(`## Code Changes\n${renderContext(context)}`);

  if (issues.length > 0) {
    const issueLines = issues.map(
      (i) => `- [${i.tool}] ${i.filename}:${i.line} (${i.severity}): ${i.message}`
    );
    parts.push(`## Static Analysis Issues\n${issueLines.join('\n')}`);
  }

  parts.push(
    `## Instructions`,
    `Review the changes above. Focus on:`,
    `- Bugs and logic errors`,
    `- Type safety and null safety issues`,
    `- Breaking changes to callers`,
    `- Security vulnerabilities`,
    `- Performance concerns`,
    ``,
    `Only comment on lines that appear in the diff. Be specific and actionable.`,
    `Use the submit_review tool to return your structured review.`
  );

  return parts.join('\n\n');
}

export async function getReview(
  apiKey: string,
  pr: PRMetadata,
  context: AssembledContext,
  issues: StaticIssue[]
): Promise<Review> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [REVIEW_TOOL],
    tool_choice: { type: 'any' },
    messages: [
      {
        role: 'user',
        content: buildPrompt(pr, context, issues),
      },
    ],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a structured review');

  const input = toolUse.input as { summary: string; comments: ReviewComment[] };
  return { summary: input.summary, comments: input.comments };
}
