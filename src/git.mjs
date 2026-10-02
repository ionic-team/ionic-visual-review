import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * @typedef {object} PullRequest
 * @property {string} baseRefName
 * @property {string} headRefOid
 * @property {string} headRefName
 * @property {string} title
 * @property {string} url
 * @property {boolean} isCrossRepository
 * @property {'OPEN' | 'CLOSED' | 'MERGED'} state
 */

/**
 * @typedef {object} ThreadComment
 * @property {string} author
 * @property {string} body Rendered HTML from GitHub.
 * @property {string} url
 * @property {string} createdAt
 * @property {boolean} mine Whether the signed-in account wrote it.
 */

/**
 * @typedef {object} Thread
 * @property {boolean} resolved
 * @property {boolean} outdated
 * @property {ThreadComment[]} comments
 */

/**
 * @typedef {object} Published
 * @property {string | null} url The review, or null for a dry run.
 * @property {number} count
 * @property {{ path: string, id: string | null }[]} posted Each comment's node id, for deleting it later.
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {object} Axes
 * @property {string | null} mode ios or md.
 * @property {string | null} theme ios, md or ionic.
 * @property {string | null} direction ltr or rtl.
 * @property {string | null} palette light when the name leaves it out.
 * @property {string | null} name What the test passed to `screenshot()`.
 */

/**
 * @typedef {Axes & { file: string, dir: string, group: string, stem: string, browser: string | null }} Described
 */

/**
 * @typedef {object} ManifestFields
 * @property {'A' | 'M' | 'D' | 'R'} status
 * @property {string} path
 * @property {string | null} oldPath Where a renamed screenshot's baseline lives.
 * @property {string | null} oldGroup
 * @property {string | null} oldStem
 * @property {number | null} similarity Git's similarity index for a rename.
 * @property {string | null} expectedSha Null for an addition.
 * @property {string | null} actualSha Null for a deletion.
 * @property {{ path: string, line: number | null } | null} [test] Set by `attachTests`.
 * @property {boolean} [orphaned] Set by `attachTests`.
 */

/** @typedef {Described & ManifestFields} ManifestEntry */

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Screenshots live next to the spec that produced them, in a folder Playwright
 * names after the spec file. Anchored with :(top) so the pathspec resolves from
 * the repository root no matter which directory the command is invoked from.
 */
/* All of core/src, not just components: typography's screenshots live under
   core/src/css, and scoping to components left them out of every review. */
export const DEFAULT_PATHSPEC = ':(top)core/src/**/*-snapshots/*.png';

/**
 * Runs git and returns what it printed.
 * @param {string[]} args
 * @param {string} cwd The repository to run in.
 * @returns {Promise<string>}
 */
export const git = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
};

/**
 * The top level of the repository containing `cwd`.
 * @param {string} cwd
 * @returns {Promise<string>} Rejects when `cwd` is not inside a repository.
 */
export const repoRoot = async (cwd) => (await git(['rev-parse', '--show-toplevel'], cwd)).trim();

/**
 * Where review state and the diff cache live. Inside the git directory, so they are
 * never committed and are shared by every worktree.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export const stateDir = async (cwd) => {
  const dir = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).trim();
  return `${dir}/snapshot-review`;
};

/**
 * Resolves a ref to a commit id.
 * @param {string} ref
 * @param {string} cwd
 * @returns {Promise<string | null>} Null when the ref does not resolve.
 */
export const resolveRef = async (ref, cwd) => {
  try {
    return (await git(['rev-parse', '--verify', `${ref}^{commit}`], cwd)).trim();
  } catch {
    return null;
  }
};

/**
 * Reads a pull request from GitHub's REST API without credentials, for reviewing
 * signed out. Anonymous reads are limited to 60 an hour, so this never polls.
 * @param {number | string} number
 * @param {string} cwd
 * @returns {Promise<PullRequest>}
 */
const restPullRequest = async (number, cwd) => {
  const slug = await remoteSlug(cwd);

  if (!slug) {
    throw new Error('origin is not a GitHub remote, so the pull request cannot be read.');
  }

  const response = await fetch(`https://api.github.com/repos/${slug}/pulls/${number}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'snapshot-review' },
  });

  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? `GitHub is rate limiting anonymous requests. Run gh auth login, or wait and retry.`
        : `Could not read pull request #${number} from GitHub (${response.status}).`
    );
  }

  const body = await response.json();

  return {
    baseRefName: body.base.ref,
    headRefOid: body.head.sha,
    headRefName: body.head.ref,
    title: body.title,
    url: body.html_url,
    isCrossRepository: body.head.repo?.full_name !== body.base.repo?.full_name,
    state: body.merged_at ? 'MERGED' : body.state === 'closed' ? 'CLOSED' : 'OPEN',
  };
};

/**
 * Resolves a pull request to the range to review. Fetches the head if it is missing
 * and the base every time, since a stale base puts the baseline at the wrong commit.
 * @param {number | string} number
 * @param {string} cwd
 * @returns {Promise<{ base: string, head: string, pr: PullRequest }>}
 */
export const resolvePullRequest = async (number, cwd) => {
  const pr = (await authenticatedUser(cwd))
    ? JSON.parse(
        (
          await execFileAsync(
            'gh',
            [
              'pr',
              'view',
              String(number),
              '--json',
              'baseRefName,headRefOid,headRefName,title,url,isCrossRepository,state',
            ],
            { cwd, maxBuffer: MAX_BUFFER }
          )
        ).stdout
      )
    : await restPullRequest(number, cwd);

  if (!(await resolveRef(pr.headRefOid, cwd))) {
    await git(['fetch', 'origin', `pull/${number}/head`], cwd);
  }

  /*
   * The base branch is fetched, not merely read.
   *
   * A head is a commit id, so having it locally is enough. A base is a branch that
   * moves, and a local copy days out of date puts the baseline at the wrong commit:
   * every screenshot the base gained since then is reported as this branch changing
   * it. Forced, because a base that was rewritten does not fast forward.
   *
   * Failure is ignored so an offline review still opens on whatever is already here.
   */
  await git(['fetch', 'origin', `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`], cwd).catch(
    () => {}
  );

  const base = (await resolveRef(`origin/${pr.baseRefName}`, cwd)) ? `origin/${pr.baseRefName}` : pr.baseRefName;

  return { base, head: pr.headRefOid, pr };
};

/**
 * The commit a pull request points at now, without fetching it. Used to notice a push.
 * @param {number | string} number
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export const headOfPullRequest = async (number, cwd) => {
  if (!(await authenticatedUser(cwd))) {
    return (await restPullRequest(number, cwd)).headRefOid;
  }

  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'view', String(number), '--json', 'headRefOid', '-q', '.headRefOid'],
    { cwd, maxBuffer: MAX_BUFFER }
  );
  return stdout.trim();
};

/**
 * Blob ids for many paths at one commit, from a single `git cat-file --batch-check`.
 * @param {string} ref
 * @param {string[]} paths
 * @param {string} cwd
 * @returns {Promise<Map<string, string | null>>} Null for a path absent at `ref`.
 */
export const blobShasAt = (ref, paths, cwd) =>
  new Promise((resolve, reject) => {
    if (paths.length === 0) {
      resolve(new Map());
      return;
    }

    const proc = spawn('git', ['cat-file', '--batch-check'], { cwd });
    let out = '';

    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.on('error', reject);
    proc.on('close', () => {
      const lines = out.split('\n').filter(Boolean);
      const shas = new Map();

      paths.forEach((path, index) => {
        const match = lines[index]?.match(/^([0-9a-f]{40}) blob /);
        shas.set(path, match ? match[1] : null);
      });

      resolve(shas);
    });

    proc.stdin.end(paths.map((path) => `${ref}:${path}\n`).join(''));
  });

/**
 * Runs one GraphQL request through the gh CLI, reducing errors to what GitHub said.
 * @param {object} options
 * @param {string} options.query
 * @param {Record<string, string>} [options.variables] Sent as strings.
 * @param {Record<string, unknown>} [options.typed] Parsed by gh, so numbers and nulls keep their type.
 * @param {string} options.cwd
 * @param {boolean} [options.tolerant] For batched mutations: return partial data and the errors
 * instead of throwing, since the other mutations in the batch still applied.
 * @returns {Promise<any>} The response data, or `{ data, errors }` when tolerant.
 */
const ghGraphql = async ({ query, variables = {}, typed = {}, cwd, tolerant = false }) => {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push('-f', `${name}=${value}`);
  }
  /* -F parses the value, which is how an Int stays an Int and a null stays null. */
  for (const [name, value] of Object.entries(typed)) {
    args.push('-F', `${name}=${value === null || value === undefined ? 'null' : value}`);
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: MAX_BUFFER }));
  } catch (error) {
    /* gh exits non-zero for a GraphQL error, but still prints the body, and that body
       says which parts succeeded. Kept when the caller can use it. */
    stdout = String(error.stdout ?? '');

    if (!tolerant || !stdout.trim()) {
      /* gh puts the detail on stderr, and its own message repeats the entire command,
         so only stderr is worth surfacing. */
      const detail = String(error.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      throw new Error(detail || 'the GitHub request failed');
    }
  }

  const parsed = JSON.parse(stdout);

  if (tolerant) {
    return { data: parsed.data ?? {}, errors: parsed.errors ?? [] };
  }

  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  return parsed.data;
};

/* One lookup per pull request: the node id does not change, and a tick should not
   pay for a subprocess to rediscover it. */
const nodeIds = new Map();

/**
 * The pull request's GraphQL node id, looked up once per pull request.
 * @param {{ number: number | string, cwd: string }} options
 * @returns {Promise<string>}
 */
const pullRequestNodeId = async ({ number, cwd }) => {
  const key = `${cwd}#${number}`;
  if (!nodeIds.has(key)) {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', String(number), '--json', 'id'], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    nodeIds.set(key, JSON.parse(stdout).id);
  }
  return nodeIds.get(key);
};

const VIEWED_CHUNK = 50;

/*
 * GitHub asks that a single user's mutations be sent one at a time, so ticking a
 * second directory queues behind the first rather than racing it.
 */
/** @type {Promise<unknown>} */
let viewedQueue = Promise.resolve();

/**
 * Runs `work` once every earlier viewed-state write has finished, since GitHub asks
 * for one user's mutations to be sent one at a time.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
const queued = (work) => {
  const result = viewedQueue.then(work, work);
  viewedQueue = result.catch(() => {});
  return result;
};

/**
 * Marks files viewed or unviewed on the pull request, 50 to a request. A path GitHub
 * rejects is reported rather than thrown, so it cannot strand the paths behind it.
 * @param {object} options
 * @param {number | string} options.number
 * @param {string[]} options.paths
 * @param {boolean} options.viewed
 * @param {string} options.cwd
 * @returns {Promise<{ marked: number, refused?: string[] }>}
 */
export const setFilesViewed = async ({ number, paths, viewed, cwd }) => {
  if (paths.length === 0) {
    return { marked: 0 };
  }

  return queued(async () => {
    const pullRequestId = await pullRequestNodeId({ number, cwd });
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';

    let marked = 0;
    /* Paths GitHub would not take. Collected rather than thrown, so one of them cannot
       strand every path queued behind it. */
    const refused = [];

    for (let start = 0; start < paths.length; start += VIEWED_CHUNK) {
      const chunk = paths.slice(start, start + VIEWED_CHUNK);

      /* One alias per file, so the whole chunk is a single round trip. Paths arrive as
         variables rather than inlined, which keeps quoting out of the query text. */
      const declarations = chunk.map((_, index) => `$p${index}: String!`).join(', ');
      const fields = chunk
        .map(
          (_, index) => `f${index}: ${mutation}(input: { pullRequestId: $id, path: $p${index} }) { clientMutationId }`
        )
        .join('\n        ');

      const variables = { id: pullRequestId };
      chunk.forEach((path, index) => {
        variables[`p${index}`] = path;
      });

      const { data } = await ghGraphql({
        query: `mutation($id: ID!, ${declarations}) {\n        ${fields}\n      }`,
        variables,
        cwd,
        tolerant: true,
      });

      /* An alias resolves to null exactly when its own mutation failed, which is a
         truer count than assuming the chunk went through whole. */
      chunk.forEach((path, index) => {
        if (data[`f${index}`]) {
          marked += 1;
        } else {
          refused.push(path);
        }
      });
    }

    return { marked, refused };
  });
};

/**
 * Every review thread on the pull request, grouped by the file it is on.
 * @param {{ number: number | string, cwd: string }} options
 * @returns {Promise<Record<string, Thread[]>>} Empty when origin is not on GitHub.
 */
export const fetchReviewThreads = async ({ number, cwd }) => {
  const slug = await remoteSlug(cwd);
  if (!slug) {
    return {};
  }

  const [OWNER, REPO] = slug.split('/');
  const byPath = new Map();
  let after = null;

  /* A guard rather than a limit anyone should reach: 20 pages is 2,000 threads. */
  for (let page = 0; page < 20; page++) {
    const data = await ghGraphql({
      query: `query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                path
                isResolved
                isOutdated
                comments(first: 20) {
                  nodes { author { login } bodyHTML createdAt url viewerDidAuthor }
                }
              }
            }
          }
        }
      }`,
      variables: { owner: OWNER, name: REPO },
      typed: { number, after },
      cwd,
    });

    const threads = data.repository.pullRequest.reviewThreads;

    for (const thread of threads.nodes) {
      if (!thread.path || thread.comments.nodes.length === 0) {
        continue;
      }

      const list = byPath.get(thread.path) ?? [];
      list.push({
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        comments: thread.comments.nodes.map((comment) => ({
          author: comment.author?.login ?? 'unknown',
          /* GitHub renders the markdown; the client keeps a safe subset of it. */
          body: comment.bodyHTML,
          url: comment.url,
          createdAt: comment.createdAt,
          mine: comment.viewerDidAuthor,
        })),
      });
      byPath.set(thread.path, list);
    }

    if (!threads.pageInfo.hasNextPage) {
      break;
    }
    after = threads.pageInfo.endCursor;
  }

  return Object.fromEntries(byPath);
};

/**
 * Posts comments as one review, so the pull request gets a single notification.
 * Always submitted as COMMENT, never as an approval or a request for changes.
 * @param {object} options
 * @param {number | string} options.number
 * @param {{ path: string, body: string }[]} options.comments
 * @param {string} options.cwd
 * @param {boolean} [options.dryRun] Build the review, then discard it.
 * @returns {Promise<Published>}
 */
export const publishComments = async ({ number, comments, cwd, dryRun = false }) => {
  const graphql = (query, variables) => ghGraphql({ query, variables, cwd });

  const { stdout } = await execFileAsync('gh', ['pr', 'view', String(number), '--json', 'id'], {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
  const pullRequestId = JSON.parse(stdout).id;

  const { addPullRequestReview } = await graphql(
    `
      mutation ($pullRequestId: ID!) {
        addPullRequestReview(input: { pullRequestId: $pullRequestId }) {
          pullRequestReview {
            id
          }
        }
      }
    `,
    { pullRequestId }
  );

  const pullRequestReviewId = addPullRequestReview.pullRequestReview.id;

  const discard = () =>
    graphql(
      `
        mutation ($pullRequestReviewId: ID!) {
          deletePullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId }) {
            clientMutationId
          }
        }
      `,
      { pullRequestReviewId }
    ).catch(() => {});

  /* The comment's own id, not the thread's, since deleting one later needs it. */
  const posted = [];

  try {
    for (const { path, body } of comments) {
      const { addPullRequestReviewThread } = await graphql(
        `
          mutation ($pullRequestReviewId: ID!, $path: String!, $body: String!) {
            addPullRequestReviewThread(
              input: { pullRequestReviewId: $pullRequestReviewId, path: $path, body: $body, subjectType: FILE }
            ) {
              thread {
                comments(first: 1) {
                  nodes {
                    id
                  }
                }
              }
            }
          }
        `,
        { pullRequestReviewId, path, body }
      );

      posted.push({ path, id: addPullRequestReviewThread.thread.comments.nodes[0]?.id ?? null });
    }
  } catch (error) {
    /* A half-populated pending review is invisible to everyone but its author and
       impossible to find later, so a partial failure takes the whole thing back. */
    await discard();
    throw error;
  }

  if (dryRun) {
    await discard();
    return { url: null, count: comments.length, posted: [], dryRun: true };
  }

  const { submitPullRequestReview } = await graphql(
    `
      mutation ($pullRequestReviewId: ID!) {
        submitPullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId, event: COMMENT }) {
          pullRequestReview {
            url
          }
        }
      }
    `,
    { pullRequestReviewId }
  );

  return { url: submitPullRequestReview.pullRequestReview.url, count: comments.length, posted };
};

/**
 * Deletes one review comment from the pull request.
 * @param {{ id: string, cwd: string }} options `id` is the comment's node id.
 * @returns {Promise<unknown>}
 */
export const deleteComment = ({ id, cwd }) =>
  ghGraphql({
    query: `mutation($id: ID!) {
      deletePullRequestReviewComment(input: { id: $id }) { clientMutationId }
    }`,
    variables: { id },
    cwd,
  });

let viewerLookup = null;

/**
 * The account gh is signed in as, looked up once per server.
 * @param {string} cwd
 * @returns {Promise<string | null>} Null when gh has no credentials.
 */
export const authenticatedUser = (cwd) => {
  viewerLookup ??= execFileAsync('gh', ['api', 'user', '--jq', '.login'], { cwd, maxBuffer: MAX_BUFFER })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);

  return viewerLookup;
};

/**
 * The `owner/repo` that origin points at, from either the SSH or HTTPS form.
 * @param {string} cwd
 * @returns {Promise<string | null>} Null when origin is not on GitHub.
 */
export const remoteSlug = async (cwd) => {
  const url = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
  const match = url.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : null;
};

/**
 * Whether a commit is on a remote branch as of the last fetch. A link to a commit that
 * only exists locally would 404.
 * @param {string} sha
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export const isOnRemote = async (sha, cwd) => {
  const branches = await git(['branch', '-r', '--contains', sha], cwd).catch(() => '');
  return branches.trim().length > 0;
};

const PLATFORMS = new Set(['linux', 'darwin', 'win32']);
const BROWSERS = new Set(['Chrome', 'Safari', 'Firefox', 'Edge', 'chromium', 'webkit', 'firefox']);

/*
 * Test axes, longest first in each list, because the shorter values are suffixes of
 * the longer ones: "md" ends "ionic-md", and "dark" ends "high-contrast-dark".
 *
 * The name carries theme and mode as a single token. They are separate axes: a mode
 * is behaviour (ios or md) and a theme is appearance (ios, md or ionic), so the ionic
 * theme runs on both modes and appears as "ionic-ios" and "ionic-md".
 */
const THEME_MODES = ['ionic-ios', 'ionic-md', 'ios', 'md'];
const PALETTES = ['high-contrast-dark', 'high-contrast', 'light', 'dark'];
const DIRECTIONS = new Set(['ltr', 'rtl']);

/**
 * Reads mode, theme, direction and palette off the end of a screenshot stem. The theme
 * is written only for ionic, and an omitted palette means light.
 * @param {string} stem The file name without browser, platform or extension.
 * @returns {Axes} All null for a name that does not follow the convention.
 */
export const splitAxes = (stem) => {
  const nothing = { mode: null, theme: null, direction: null, palette: null, name: null };
  let rest = stem;
  let palette = null;

  for (const candidate of PALETTES) {
    if (rest.endsWith(`-${candidate}`)) {
      palette = candidate;
      rest = rest.slice(0, -(candidate.length + 1));
      break;
    }
  }

  const tokens = rest.split('-');
  const direction = tokens[tokens.length - 1];

  if (!DIRECTIONS.has(direction)) {
    return nothing;
  }

  rest = rest.slice(0, -(direction.length + 1));

  const themeMode = THEME_MODES.find((candidate) => rest === candidate || rest.endsWith(`-${candidate}`));

  if (!themeMode) {
    return nothing;
  }

  const [theme, mode] = themeMode.split('-');

  return {
    /* A bare "md" is both the theme and the mode. */
    mode: mode ?? theme,
    theme,
    direction,
    /* An omitted palette means light; that is why it is omitted. */
    palette: palette ?? 'light',
    /* What is left once every axis is stripped: the name the test passed to
       screenshot(), which is how a screenshot is traced back to the line that took it. */
    name: rest === themeMode ? '' : rest.slice(0, -(themeMode.length + 1)),
  };
};

/**
 * Splits a screenshot file name into its stem, browser and test axes. Read from the
 * end, because project names like "Mobile Chrome" contain hyphens.
 * @param {string} file
 * @returns {{ stem: string, browser: string | null } & Axes}
 */
export const splitName = (file) => {
  const tokens = file.replace(/\.png$/, '').split('-');

  if (!PLATFORMS.has(tokens[tokens.length - 1]) || !BROWSERS.has(tokens[tokens.length - 2])) {
    const stem = file.replace(/\.png$/, '');
    return { stem, browser: null, ...splitAxes(stem) };
  }

  /* Trailing tokens are the project name plus the platform: "Mobile-Chrome-linux". */
  const trailing = tokens[tokens.length - 3] === 'Mobile' ? 3 : 2;
  const stem = tokens.slice(0, -trailing).join('-');

  return {
    stem,
    browser: tokens.slice(-trailing, -1).join(' '),
    ...splitAxes(stem),
  };
};

/**
 * Everything the review shows about a screenshot path.
 * @param {string} path Relative to the repository root.
 * @returns {Described}
 */
export const describe = (path) => {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');

  return {
    file,
    dir,
    /* "textarea/test/slot" reads better than the full path. The trailing snapshots
       folder is named after the spec and carries nothing the group does not. Anything
       outside components keeps one level of context, so "css/test/a11y". */
    group: dir
      .replace(/^core\/src\/components\//, '')
      .replace(/^core\/src\//, '')
      .replace(/\/[^/]+-snapshots$/, ''),
    ...splitName(file),
  };
};

/* An absent side, for an addition or a deletion. */
const NULL_SHA = '0000000000000000000000000000000000000000';

/*
 * Tracing a screenshot back to the line that took it.
 *
 * Playwright keeps a spec's screenshots in "<spec>-snapshots", so the test file is the
 * directory minus that suffix. Inside it, the name the snapshot was saved under is the
 * argument to screenshot(), which is usually a literal and occasionally a template.
 * The template case is kept by turning the interpolation into a wildcard, which is
 * enough to place four out of five of the ones a literal search misses.
 */
const SCREENSHOT_CALL = /screenshot\(\s*[`'"]([^`'"]*)[`'"]/g;

/**
 * Every `screenshot()` call in a spec. A name built from a template literal gets a
 * pattern with the interpolation as a wildcard.
 * @param {string} source The spec's contents.
 * @returns {{ line: number, raw: string, pattern: RegExp | null }[]}
 */
export const indexScreenshotCalls = (source) => {
  const calls = [];

  source.split('\n').forEach((text, index) => {
    for (const [, raw] of text.matchAll(SCREENSHOT_CALL)) {
      const pattern = raw.includes('${')
        ? new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$\\\{[^}]*\\\}/g, '.+')}$`)
        : null;
      calls.push({ line: index + 1, raw, pattern });
    }
  });

  return calls;
};

/**
 * Sets `test` and `orphaned` on each entry from the spec that took it. `test.line` is
 * null when the call cannot be placed, and `test` is null when the spec is gone.
 * @param {{ entries: ManifestEntry[], ref: string, cwd: string }} options
 * @returns {Promise<void>}
 */
export const attachTests = async ({ entries, ref, cwd }) => {
  const specs = new Map();

  for (const dir of new Set(entries.map((entry) => entry.dir))) {
    const path = dir.replace(/-snapshots$/, '');
    let calls = null;

    try {
      calls = indexScreenshotCalls(await git(['show', `${ref}:${path}`], cwd));
    } catch {
      /* No spec at this ref: the screenshots outlived the test that wrote them. */
    }

    specs.set(dir, { path, calls });
  }

  for (const entry of entries) {
    const spec = specs.get(entry.dir);

    if (!spec?.calls) {
      entry.test = null;
      /* A screenshot being deleted is meant to have no spec; one that survives without
         one will be regenerated forever with nothing asserting on it. */
      entry.orphaned = entry.status !== 'D';
      continue;
    }

    const exact = spec.calls.filter((call) => call.raw === entry.name);
    const loose = exact.length ? exact : spec.calls.filter((call) => call.pattern?.test(entry.name ?? ''));

    entry.test = { path: spec.path, line: loose.length === 1 ? loose[0].line : null };
    entry.orphaned = false;
  }
};

/**
 * Lists the screenshots that changed between the merge base and `head`. Three-dot, so
 * the set holds still when the base moves, with each side's blob id from `--raw`.
 * @param {object} options
 * @param {string} options.base
 * @param {string} options.head
 * @param {string} [options.pathspec]
 * @param {string} options.cwd
 * @returns {Promise<{ mergeBase: string, entries: ManifestEntry[] }>}
 */
export const buildManifest = async ({ base, head, pathspec = DEFAULT_PATHSPEC, cwd }) => {
  const mergeBase = (await git(['merge-base', base, head], cwd)).trim();
  const raw = await git(['diff', '--raw', '--abbrev=40', `${base}...${head}`, '--', pathspec], cwd);

  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, ...paths] = line.split('\t');
      const [, , expectedSha, actualSha, status] = meta.split(' ');

      const renamed = paths.length > 1;
      /* The new path is what the review is about; the old one is where its baseline
         still lives, and both sides are needed to compare a renamed screenshot. */
      const path = renamed ? paths[1] : paths[0];

      /* Described too, so the client can show where it moved from in the same terms
         it shows everything else, rather than a raw path. */
      const previous = renamed ? describe(paths[0]) : null;

      return {
        status: /** @type {ManifestFields['status']} */ (status[0]),
        path,
        oldPath: renamed ? paths[0] : null,
        oldGroup: previous?.group ?? null,
        oldStem: previous?.stem ?? null,
        /* Git's similarity index, so a pure move reads differently from a move that
           also changed the image. */
        similarity: renamed ? Number(status.slice(1)) : null,
        expectedSha: expectedSha === NULL_SHA ? null : expectedSha,
        actualSha: actualSha === NULL_SHA ? null : actualSha,
        ...describe(path),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { mergeBase, entries };
};

/**
 * Reads blobs through one long-lived `git cat-file --batch`, rather than spawning a
 * process per image.
 */
export class BlobReader {
  /**
   * @param {string} cwd The repository to read from.
   */
  constructor(cwd) {
    this.queue = [];
    this.buffer = Buffer.alloc(0);
    this.expecting = null;

    this.proc = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    this.proc.on('exit', () => {
      /* Fail any in-flight reads rather than leaving their promises pending. */
      while (this.queue.length) {
        this.queue.shift().reject(new Error('git cat-file exited'));
      }
    });
  }

  /**
   * Reads one blob.
   * @param {string} ref
   * @param {string} path
   * @returns {Promise<Buffer | null>} Null when the path is absent at `ref`.
   */
  read(ref, path) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(`${ref}:${path}\n`);
    });
  }

  /** Resolves queued reads as their headers and bodies arrive on stdout. */
  #drain() {
    for (;;) {
      if (this.expecting === null) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline === -1) {
          return;
        }

        const header = this.buffer.subarray(0, newline).toString();
        this.buffer = this.buffer.subarray(newline + 1);

        const match = header.match(/^[0-9a-f]{40,} \w+ (\d+)$/);
        if (!match) {
          /* Missing or ambiguous objects report on a single line with no body. */
          this.queue.shift()?.resolve(null);
          continue;
        }

        this.expecting = Number(match[1]);
      }

      /* The body is followed by a trailing newline that is not part of the blob. */
      if (this.buffer.length < this.expecting + 1) {
        return;
      }

      const body = this.buffer.subarray(0, this.expecting);
      this.buffer = this.buffer.subarray(this.expecting + 1);
      this.expecting = null;
      this.queue.shift()?.resolve(body);
    }
  }

  /** Stops the git process. */
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

/**
 * Reads width and height from the PNG header without decoding the image.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | null} Null when too short to be a PNG.
 */
export const pngSize = (buffer) => {
  if (!buffer || buffer.length < 24) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};
