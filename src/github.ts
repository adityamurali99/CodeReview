import { Octokit } from '@octokit/rest';

export interface PRMetadata {
  number: number;
  title: string;
  description: string;
  baseSha: string;
  headSha: string;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  patch: string | null;
  oldContent: string | null;
  newContent: string | null;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(octokit: Octokit, owner: string, repo: string) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  async getPRMetadata(prNumber: number): Promise<PRMetadata> {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return {
      number: data.number,
      title: data.title,
      description: data.body ?? '',
      baseSha: data.base.sha,
      headSha: data.head.sha,
    };
  }

  async getChangedFiles(pr: PRMetadata): Promise<ChangedFile[]> {
    const { data } = await this.octokit.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: pr.number,
      per_page: 100,
    });

    return Promise.all(
      data.map(async (file) => {
        const status = file.status as ChangedFile['status'];
        const [oldContent, newContent] = await Promise.all([
          status !== 'added' ? this.fetchFileContent(file.filename, pr.baseSha) : null,
          status !== 'deleted' ? this.fetchFileContent(file.filename, pr.headSha) : null,
        ]);

        return {
          filename: file.filename,
          status,
          patch: file.patch ?? null,
          oldContent,
          newContent,
        };
      })
    );
  }

  async getFileTree(sha: string): Promise<string[]> {
    const { data } = await this.octokit.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: sha,
      recursive: '1',
    });

    return (data.tree ?? [])
      .filter((item) => item.type === 'blob' && item.path != null)
      .map((item) => item.path as string);
  }

  async batchGetFileContents(paths: string[], ref: string): Promise<Map<string, string>> {
    const BATCH_SIZE = 10;
    const result = new Map<string, string>();

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (p) => {
          const content = await this.fetchFileContent(p, ref);
          if (content !== null) result.set(p, content);
        })
      );
    }

    return result;
  }

  private async fetchFileContent(filePath: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref,
      });

      if (Array.isArray(data) || data.type !== 'file') return null;

      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && err.status === 404;
}
