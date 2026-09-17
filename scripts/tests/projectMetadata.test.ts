import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assembleProjectMetadata,
  collectPullRequestCoAuthors,
  compareTimelineEvents,
  generateProjectMetadata,
  githubGetAllPages,
  languageBreakdown,
  parseCoAuthorTrailers,
  publicIdentityFromTrailer,
  shouldIncludeMergedPullRequest,
  validateProjectMetadata,
} from '../projectMetadata.mjs';

const jsonHeaders = (extra = {}) => ({
  get: (name) => extra[name.toLowerCase()] ?? extra[name] ?? null,
});

describe('languageBreakdown', () => {
  it('calculates Linguist percentages from GitHub Languages API byte counts', () => {
    const languages = languageBreakdown({
      TypeScript: 494246,
      CSS: 32415,
      JavaScript: 4466,
      HTML: 3562,
    });
    const total = 494246 + 32415 + 4466 + 3562;
    expect(languages.map((language) => language.name)).toEqual(['TypeScript', 'CSS', 'JavaScript', 'HTML']);
    expect(languages[0]).toEqual({
      name: 'TypeScript',
      bytes: 494246,
      percentage: Math.round((494246 / total) * 1000) / 10,
    });
    expect(languages.find((language) => language.name === 'Python')).toBeUndefined();
  });

  it('includes a newly introduced language without a whitelist', () => {
    const languages = languageBreakdown({ TypeScript: 90, Python: 10 });
    expect(languages).toEqual([
      { name: 'TypeScript', bytes: 90, percentage: 90 },
      { name: 'Python', bytes: 10, percentage: 10 },
    ]);
  });

  it('rejects non-object Languages API payloads', () => {
    expect(() => languageBreakdown([{ name: 'TypeScript' }])).toThrow(/object of language name/);
  });
});

describe('co-author trailers', () => {
  it('uses GitHub noreply usernames and never stores private emails', () => {
    expect(publicIdentityFromTrailer('Bailey P Forbes', 'BPForbes@users.noreply.github.com')).toBe('BPForbes');
    expect(publicIdentityFromTrailer('Bailey', '123456+BPForbes@users.noreply.github.com')).toBe('BPForbes');
    expect(publicIdentityFromTrailer('Bailey P Forbes', 'bailey@example.com')).toBe('Bailey P Forbes');
    expect(parseCoAuthorTrailers(
      'Restore missing inputs\n\nCo-authored-by: Bailey P Forbes <BPForbes@users.noreply.github.com>\nCo-authored-by: Secret <human@example.com>\n',
    )).toEqual(['BPForbes', 'Secret']);
    expect(JSON.stringify(parseCoAuthorTrailers('Co-authored-by: Secret <human@example.com>\n'))).not.toMatch(/@example\.com/);
  });
});

describe('merged PR selection', () => {
  it('keeps agent-assisted PRs with human co-authors or a human merger', () => {
    expect(shouldIncludeMergedPullRequest({
      mergedAt: '2026-06-12T04:25:33Z',
      author: 'coderabbitai[bot]',
      authorType: 'Bot',
      merger: 'BPForbes',
      mergerType: 'User',
      coAuthors: ['BPForbes'],
    })).toBe(true);

    expect(shouldIncludeMergedPullRequest({
      mergedAt: '2026-09-17T12:00:00Z',
      author: 'cursoragent',
      authorType: 'User',
      merger: 'BPForbes',
      mergerType: 'User',
      coAuthors: ['BPForbes'],
    })).toBe(true);
  });

  it('excludes closed-but-unmerged PRs and routine dependabot maintenance', () => {
    expect(shouldIncludeMergedPullRequest({
      mergedAt: null,
      author: 'BPForbes',
      authorType: 'User',
    })).toBe(false);

    expect(shouldIncludeMergedPullRequest({
      mergedAt: '2026-01-01T00:00:00Z',
      author: 'dependabot[bot]',
      authorType: 'Bot',
      merger: 'BPForbes',
      mergerType: 'User',
      coAuthors: [],
    })).toBe(false);
  });
});

describe('timeline ordering', () => {
  it('orders newest events first', () => {
    const events = [
      { type: 'pull_request', number: 1, mergedAt: '2026-01-01T00:00:00Z' },
      { type: 'release', tag: 'v1.0.0', publishedAt: '2026-09-01T00:00:00Z' },
      { type: 'pull_request', number: 2, mergedAt: '2026-06-01T00:00:00Z' },
    ].sort(compareTimelineEvents);
    expect(events.map((event) => event.tag ?? event.number)).toEqual(['v1.0.0', 2, 1]);
  });
});

describe('validateProjectMetadata', () => {
  const valid = () => assembleProjectMetadata({
    repository: {
      owner: 'BPForbes',
      name: 'BPForbes.QPU.github.io',
      defaultBranch: 'main',
      url: 'https://github.com/BPForbes/BPForbes.QPU.github.io',
    },
    languages: [{ name: 'TypeScript', bytes: 90, percentage: 90 }, { name: 'CSS', bytes: 10, percentage: 10 }],
    timeline: [{
      type: 'pull_request',
      number: 12,
      title: 'Add visualization',
      mergedAt: '2026-09-17T12:00:00Z',
      url: 'https://github.com/BPForbes/BPForbes.QPU.github.io/pull/12',
      author: 'cursoragent',
      coAuthors: ['BPForbes'],
    }],
    sourceCommit: 'abcdef1234567',
    generatedAt: '2026-09-17T12:00:00Z',
    workflow: 'Deploy static React QPU app',
  });

  it('accepts schemaVersion 1 documents', () => {
    expect(valid().schemaVersion).toBe(1);
  });

  it('rejects emails and unsorted languages', () => {
    const metadata = valid();
    expect(() => validateProjectMetadata({
      ...metadata,
      timeline: [{ ...metadata.timeline[0], author: 'bailey@example.com' }],
    })).toThrow(/email/);
    expect(() => validateProjectMetadata({
      ...metadata,
      languages: [...metadata.languages].reverse(),
    })).toThrow(/sorted/);
  });
});

describe('generateProjectMetadata', () => {
  const repo = {
    owner: { login: 'BPForbes' },
    name: 'BPForbes.QPU.github.io',
    default_branch: 'main',
    html_url: 'https://github.com/BPForbes/BPForbes.QPU.github.io',
  };

  const pulls = [
    {
      number: 25,
      title: 'CodeRabbit Chat: Implement requested code changes',
      merged_at: '2026-06-12T04:25:33Z',
      html_url: 'https://github.com/BPForbes/BPForbes.QPU.github.io/pull/25',
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
    },
    {
      number: 37,
      title: 'Address routed-page review feedback',
      merged_at: null,
      html_url: 'https://github.com/BPForbes/BPForbes.QPU.github.io/pull/37',
      user: { login: 'BPForbes', type: 'User' },
    },
    {
      number: 39,
      title: 'Expand QPU circuit protocol PDF reference',
      merged_at: '2026-09-13T21:17:22Z',
      html_url: 'https://github.com/BPForbes/BPForbes.QPU.github.io/pull/39',
      user: { login: 'BPForbes', type: 'User' },
    },
    {
      number: 2,
      title: 'Bump actions/checkout from 4 to 5',
      merged_at: '2026-01-02T00:00:00Z',
      html_url: 'https://github.com/BPForbes/BPForbes.QPU.github.io/pull/2',
      user: { login: 'dependabot[bot]', type: 'Bot' },
    },
  ];

  const routes = {
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io': repo,
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/languages': {
      TypeScript: 90,
      CSS: 10,
    },
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls?state=closed&sort=updated&direction=desc&per_page=100': pulls,
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls/25/commits?per_page=100': [
      {
        commit: {
          message: 'Implement requested code changes\n\nCo-authored-by: Bailey P Forbes <BPForbes@users.noreply.github.com>\n',
        },
      },
    ],
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls/25': {
      merged_by: { login: 'BPForbes', type: 'User' },
    },
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls/39/commits?per_page=100': [],
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls/2/commits?per_page=100': [],
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/pulls/2': {
      merged_by: { login: 'BPForbes', type: 'User' },
    },
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/releases?per_page=100': [
      { draft: true, tag_name: '', published_at: null },
    ],
    'https://api.github.com/repos/BPForbes/BPForbes.QPU.github.io/tags?per_page=100': [],
  };

  const fetchImpl = async (url) => {
    if (url.includes('secret-token') || url.includes('GITHUB_TOKEN')) {
      throw new Error('token leaked into the request URL');
    }
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected GitHub request ${url}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: jsonHeaders(),
      json: async () => body,
    };
  };

  it('builds schemaVersion 1 metadata from GitHub REST payloads without leaking credentials', async () => {
    const metadata = await generateProjectMetadata({
      token: 'secret-token',
      repository: 'BPForbes/BPForbes.QPU.github.io',
      sourceCommit: 'abc1234def5678901234567890abcdef12345678',
      workflow: 'Deploy static React QPU app',
      generatedAt: '2026-09-17T12:00:00Z',
      fetchImpl,
    });

    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.sourceCommit).toBe('abc1234def5678901234567890abcdef12345678');
    expect(metadata.languages).toEqual([
      { name: 'TypeScript', bytes: 90, percentage: 90 },
      { name: 'CSS', bytes: 10, percentage: 10 },
    ]);
    expect(metadata.timeline.map((event) => event.number)).toEqual([39, 25]);
    expect(metadata.timeline[1]).toMatchObject({
      type: 'pull_request',
      author: 'coderabbitai[bot]',
      coAuthors: ['BPForbes'],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/secret-token|authorization|example\.com/i);
  });

  it('follows GitHub Link pagination', async () => {
    const pages = {
      'https://api.github.com/items?page=1': { body: [{ id: 1 }], link: '<https://api.github.com/items?page=2>; rel="next"' },
      'https://api.github.com/items?page=2': { body: [{ id: 2 }], link: null },
    };
    const items = await githubGetAllPages('https://api.github.com/items?page=1', {
      token: 'secret-token',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: jsonHeaders({ link: pages[url].link }),
        json: async () => pages[url].body,
      }),
    });
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('fails clearly when a required GitHub API request fails', async () => {
    await expect(generateProjectMetadata({
      token: 'secret-token',
      repository: 'BPForbes/BPForbes.QPU.github.io',
      sourceCommit: 'abc1234',
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        headers: jsonHeaders(),
        json: async () => ({ message: 'boom' }),
      }),
    })).rejects.toThrow(/GitHub API request failed: 500/);
  });

  it('handles GitHub rate-limit responses', async () => {
    await expect(generateProjectMetadata({
      token: 'secret-token',
      repository: 'BPForbes/BPForbes.QPU.github.io',
      sourceCommit: 'abc1234',
      fetchImpl: async (url) => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: jsonHeaders({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1710000000' }),
        json: async () => ({ message: 'rate limit', url }),
      }),
    })).rejects.toThrow(/rate limited \(403\)/);
  });
});

describe('collectPullRequestCoAuthors', () => {
  it('deduplicates trailer identities from commit messages', () => {
    expect(collectPullRequestCoAuthors([
      { commit: { message: 'A\n\nCo-authored-by: Bailey <BPForbes@users.noreply.github.com>' } },
      { commit: { message: 'B\n\nCo-authored-by: Bailey P Forbes <BPForbes@users.noreply.github.com>' } },
    ])).toEqual(['BPForbes']);
  });
});

describe('generate-project-metadata CLI validation', () => {
  it('validates a well-formed metadata file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qpu-metadata-'));
    const path = join(directory, 'project-metadata.json');
    const metadata = assembleProjectMetadata({
      repository: {
        owner: 'BPForbes',
        name: 'BPForbes.QPU.github.io',
        defaultBranch: 'main',
        url: 'https://github.com/BPForbes/BPForbes.QPU.github.io',
      },
      languages: [{ name: 'TypeScript', bytes: 1, percentage: 100 }],
      timeline: [],
      sourceCommit: 'abc1234',
      generatedAt: '2026-09-17T12:00:00Z',
      workflow: 'Deploy static React QPU app',
    });
    writeFileSync(path, JSON.stringify(metadata));
    const result = spawnSync(process.execPath, ['scripts/generate-project-metadata.mjs', '--validate', path], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('schemaVersion 1');
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1);
  });
});
