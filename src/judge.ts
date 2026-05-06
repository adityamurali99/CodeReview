import Anthropic from '@anthropic-ai/sdk';
import { ReviewComment } from './reviewer';
import { AssembledContext, renderContext } from './context-builder';
import { PRMetadata } from './github';

const CONFIDENCE_THRESHOLD = 0.7;

interface CommentVerdict {
  index: number;
  confidence: number;
  reasoning: string;
  severity: ReviewComment['severity'];
}

interface JudgeResult {
  verdicts: CommentVerdict[];
}

const MODEL = 'claude-sonnet-4-6';

const JUDGE_TOOL: Anthropic.Tool = {
  name: 'submit_verdicts',
  description: 'Submit confidence scores for each review comment.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'Index of the comment in the original list.' },
            confidence: {
              type: 'number',
              description: [
                'Confidence that this is a real issue from 0.0 to 1.0.',
                '0.9-1.0: code clearly confirms the issue.',
                '0.7-0.9: reasonably sure but some context may be missing.',
                '0.5-0.7: uncertain due to missing context.',
                'below 0.5: guessing.',
              ].join(' '),
            },
            reasoning: { type: 'string', description: 'One sentence explaining the confidence score.' },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'error'],
              description: 'Severity of the issue — adjust down if the original was overstated.',
            },
          },
          required: ['index', 'confidence', 'reasoning', 'severity'],
        },
      },
    },
    required: ['verdicts'],
  },
};

function buildJudgePrompt(
  pr: PRMetadata,
  comments: ReviewComment[],
  context: AssembledContext
): string {
  const commentList = comments
    .map((c, i) => `[${i}] ${c.filename}:${c.line} (${c.severity})\n${c.body}`)
    .join('\n\n');

  return [
    `# Judge Review Comments for PR #${pr.number}: ${pr.title}`,
    `## Code Context\n${renderContext(context)}`,
    `## Comments to Evaluate\n${commentList}`,
    `## Instructions`,
    `You are a skeptical senior engineer auditing an AI reviewer's output. Your job is to find flaws in its reasoning — not to agree with it.`,
    `For each comment, re-read the relevant code carefully and ask:`,
    `- Is the reviewer misreading the code? Look again.`,
    `- Is this issue already handled somewhere the reviewer missed?`,
    `- Is the reviewer pattern-matching to a common bug without checking if it actually applies here?`,
    `- Is the comment too vague to be actionable by a developer?`,
    `Assume the reviewer made at least one mistake. Your job is to find it.`,
    `Score your confidence that each comment describes a real issue (0.0 to 1.0):`,
    `- 0.9-1.0: the code clearly has this problem`,
    `- 0.7-0.9: reasonably sure but some context may be missing`,
    `- 0.5-0.7: uncertain — hard to verify from available context`,
    `- below 0.5: likely a false positive`,
    `Also set the correct severity. Adjust it down if the original overstated the impact.`,
    `Use the submit_verdicts tool to return your scores.`,
  ].join('\n\n');
}

export async function judgeReview(
  client: Anthropic,
  pr: PRMetadata,
  comments: ReviewComment[],
  context: AssembledContext
): Promise<ReviewComment[]> {
  if (comments.length === 0) return [];

  const { log } = await import('./logger');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [JUDGE_TOOL],
    tool_choice: { type: 'any' },
    messages: [
      {
        role: 'user',
        content: buildJudgePrompt(pr, comments, context),
      },
    ],
  });

  log().debug({ stopReason: response.stop_reason }, 'judge: raw response');

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('Judge did not return structured verdicts');

  const { verdicts } = toolUse.input as JudgeResult;

  for (const v of verdicts) {
    const comment = comments[v.index];
    const passed = v.confidence >= CONFIDENCE_THRESHOLD;
    log().debug(
      {
        index: v.index,
        file: comment?.filename,
        line: comment?.line,
        confidence: v.confidence,
        severity: v.severity,
        passed,
        reasoning: v.reasoning,
      },
      passed ? 'judge: comment passed' : 'judge: comment filtered'
    );
  }

  return verdicts
    .filter((v) => v.confidence >= CONFIDENCE_THRESHOLD)
    .map((v) => {
      const comment = comments[v.index];
      if (!comment) throw new Error(`Judge returned invalid comment index: ${v.index}`);
      return { ...comment, severity: v.severity };
    });
}
