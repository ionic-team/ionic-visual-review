/**
 * Local reviewer for screenshot diffs: the server behind the page.
 *
 * GitHub's Files tab won't render pull requests with hundreds of binary files, which
 * is every screenshot regeneration this repository produces. This serves the same
 * before and after pairs out of the git object store instead.
 *
 * - The clone comes from --repo, else ../ionic-framework next to this repository,
 *   else a path typed in at the prompt. With no terminal to ask in, it exits.
 * - A pull request (--pr) is pinned to its head commit at startup, and its base branch
 *   is fetched so the baseline is current. A range (--base, --head) is read locally
 *   and never contacts GitHub.
 * - Signed out of gh, a pull request still opens: a yellow warning prints, teammates'
 *   comments are not shown, nothing can be posted, and viewed marks stay local.
 * - Each pair is diffed once and cached by the two images' blob ids, so a push only
 *   diffs what it changed. Cache entries unused for 14 days are deleted at startup.
 * - Viewed marks and comments are saved per pull request, or per range, in the
 *   clone's .git/snapshot-review. A mark survives a push only if neither image
 *   changed. A comment always survives, flagged stale if its screenshot changed.
 * - Viewed marks are mirrored to the pull request's Files tab when signed in.
 *   Comments reach GitHub only through Post, and deleting a posted one removes it
 *   there first.
 * - A newer push is looked for on load, on tab focus and on every mark, at most every
 *   2 seconds for a range, 30 for a pull request, and 5 minutes signed out. Refresh
 *   rebuilds on it without a restart, and keeps the current review if that fails.
 * - Port 4300, or the next free one up to 4320.
 *
 * Usage:
 *   npm start -- --pr 31321
 *   npm start -- --repo ~/code/ionic-framework --pr 31321
 *   npm start -- --base origin/main --head my-branch
 *   npm start -- --pr 31321 --path ':(top)core/src/components/textarea/**\/*.png'
 */
import { execFile } from 'node:child_process';
import { readFile, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import sirv from 'sirv';

import { comparePng, pngSize } from './diff.mjs';
import {
  BlobReader,
  DEFAULT_PATHSPEC,
  blobShasAt,
  attachTests,
  authenticatedUser,
  buildManifest,
  git,
  deleteComment,
  fetchReviewThreads,
  isOnRemote,
  publishComments,
  remoteSlug,
  setFilesViewed,
  headOfPullRequest,
  repoRoot,
  resolvePullRequest,
  resolveRef,
  stateDir,
} from './git.mjs';

/** @typedef {import('./git.mjs').ManifestEntry} ManifestEntry */
/** @typedef {import('./git.mjs').Thread} Thread */

/**
 * @typedef {object} Args
 * @property {string} [repo] The checkout to review.
 * @property {string} [pr]
 * @property {string} [base]
 * @property {string} [head]
 * @property {string} [path] A git pathspec narrowing the set.
 * @property {string} port
 * @property {boolean} open
 * @property {boolean} help
 */

/**
 * @typedef {object} Range
 * @property {string} base
 * @property {string} head
 * @property {string} label Shown in the header and the startup banner.
 * @property {string | null} url The pull request, when there is one.
 * @property {'OPEN' | 'CLOSED' | 'MERGED' | null} prState
 */

/**
 * @typedef {object} ReviewFields
 * @property {boolean} comparable Both sides exist.
 * @property {{ width: number, height: number } | null} size
 * @property {{ width: number, height: number } | null} expectedSize
 * @property {{ width: number, height: number } | null} actualSize
 * @property {number | null} ratio Changed pixels as a share of the canvas.
 * @property {number | null} changed Changed pixels.
 * @property {boolean} resized
 * @property {{ expected: number | null, actual: number | null }} bytes
 */

/** @typedef {ManifestEntry & ReviewFields} ReviewEntry */

/**
 * @typedef {object} Freshness
 * @property {boolean} moved
 * @property {string} [head] The newer commit.
 * @property {string[]} [changed] Of the paths asked about, those the newer commit changed.
 */

/**
 * @typedef {object} Store
 * @property {string} file
 * @property {{ carried: number, reset: number }} summary
 * @property {() => ReviewState} read The state sent to the client.
 * @property {() => { path: string, body: string }[]} unsentComments
 * @property {(posted: { path: string, id: string | null }[]) => void} markPosted
 * @property {(path: string) => string | null} postedIdFor
 * @property {(path: string) => void} forgetComment
 * @property {(patch: Patch) => { flipped: string[] }} update
 */

/**
 * @typedef {object} ReviewState
 * @property {Record<string, true>} viewed
 * @property {Record<string, string>} comments
 * @property {string[]} stale
 * @property {string[]} unsent
 * @property {string[]} posted
 */

/**
 * One write from the client: a single path or a directory's worth.
 * @typedef {object} Patch
 * @property {string} [path]
 * @property {string[]} [paths]
 * @property {boolean} [viewed]
 * @property {string} [comment]
 */

/**
 * @typedef {object} Review
 * @property {Record<string, Thread[]>} threads Teammates' comments, by path.
 * @property {{ repo: string, expected: string | null, actual: string | null } | null} blobBase For GitHub links.
 * @property {number} pruned
 * @property {number} computed
 * @property {number} reused
 * @property {string} headSha
 * @property {string} mergeBase
 * @property {ReviewEntry[]} entries
 * @property {Map<string, string>} diffs
 * @property {Store} store
 * @property {Record<string, number>} counts By status.
 * @property {Map<string, string>} baselinePaths Where a renamed screenshot's baseline lives.
 * @property {Map<string, ReviewEntry>} byPath
 * @property {ReturnType<typeof createFreshness>} pushWatch
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(HERE, 'client');
/* Resolved rather than walked to, so it is found wherever npm put node_modules. */
const SLIDER_PKG = join(dirname(createRequire(import.meta.url).resolve('img-comparison-slider/package.json')), 'dist');
const DEFAULT_PORT = 4300;

/* Yellow only on a terminal, since styleText checks stdout before colouring. */
const NO_ACCOUNT = styleText(
  'yellow',
  [
    '  ⚠ Not signed in to GitHub. Run gh auth login, then restart.',
    "    The review works, but comments can't be posted and viewed marks stay local.",
  ].join('\n')
);

const usage = `
Review screenshot diffs locally.

  --repo <path>     The ionic-framework checkout to review. Defaults to
                    ../ionic-framework next to the reviewer, and asks
                    when that is missing.
  --pr <number>     Review a pull request.
  --base <ref>      Compare from this ref instead of a pull request base.
  --head <ref>      Compare to this ref.
  --path <spec>     Narrow the set with a git pathspec.
  --port <number>   Defaults to ${DEFAULT_PORT}.
  --no-open         Do not open a browser.
`;

/**
 * Parses the command line.
 * @returns {Args}
 */
const readArgs = () => {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      path: { type: 'string' },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      open: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowNegative: true,
  });
  return values;
};

/**
 * Resolves the arguments to the range under review: a pull request, or `--base` and
 * `--head`. Given with `--pr`, `--base` and `--head` override the pull request's own ends.
 * @param {Args} args
 * @param {string} cwd
 * @returns {Promise<Range>}
 */
const resolveRange = async (args, cwd) => {
  if (args.pr) {
    const { base, head, pr } = await resolvePullRequest(args.pr, cwd);
    return {
      base: args.base ?? base,
      head: args.head ?? head,
      label: `#${args.pr} ${pr.title}`,
      url: pr.url,
      prState: pr.state,
    };
  }

  if (!args.base || !args.head) {
    throw new Error('Pass --pr <number>, or both --base <ref> and --head <ref>.');
  }

  for (const ref of [args.base, args.head]) {
    if (!(await resolveRef(ref, cwd))) {
      throw new Error(`Cannot resolve ref: ${ref}`);
    }
  }

  return { base: args.base, head: args.head, label: `${args.base}...${args.head}`, url: null, prState: null };
};

/**
 * Names the review's state file after the pull request, or the refs as typed, so marks
 * survive new pushes.
 * @param {Args} args
 * @param {Range} range
 * @returns {string} Safe to use as a file name.
 */
export const reviewKey = (args, range) => {
  const raw = args.pr ? `pr-${args.pr}` : `${range.base}..${range.head}`;
  return raw.replace(/[^a-z0-9._-]/gi, '_');
};

/**
 * Loads the review's viewed marks and comments. A mark survives only while both of its
 * screenshot's blobs are unchanged; a comment survives regardless, flagged stale.
 * @param {string} cwd
 * @param {string} key From `reviewKey`.
 * @param {ReviewEntry[]} entries
 * @returns {Promise<Store>}
 */
export const createStore = async (cwd, key, entries) => {
  const dir = await stateDir(cwd);
  const file = join(dir, `${key}.json`);

  let stored = { entries: {} };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      stored = parsed;
    }
  } catch {
    /* No prior session for this review. */
  }

  const current = new Map(entries.map((entry) => [entry.path, entry]));
  const state = { viewed: {}, comments: {}, stale: [], unsent: [], posted: [] };
  let carried = 0;
  let reset = 0;

  for (const [path, record] of Object.entries(stored.entries)) {
    const entry = current.get(path);
    if (!entry) {
      continue;
    }

    const unchanged = record.expectedSha === entry.expectedSha && record.actualSha === entry.actualSha;

    if (record.comment) {
      state.comments[path] = record.comment;
      if (!unchanged) {
        state.stale.push(path);
      }
      /* Never posted, or edited since it was. */
      if (record.comment !== record.postedComment) {
        state.unsent.push(path);
      }
    }

    /* Still on the pull request, whatever the local text says now. */
    if (record.postedId) {
      state.posted.push(path);
    }

    if (record.viewed && unchanged) {
      state.viewed[path] = true;
      carried++;
    } else if (record.viewed) {
      reset++;
    }
  }

  /* Rewritten from the surviving records, so entries that left the range are dropped
     rather than accumulating forever. */
  const live = {};
  /* A path with a comment still on the pull request is kept even once the local text
     is gone, because its id is the only way to delete it later. */
  for (const path of new Set([...Object.keys(state.viewed), ...Object.keys(state.comments), ...state.posted])) {
    const entry = current.get(path);
    live[path] = {
      viewed: Boolean(state.viewed[path]),
      comment: state.comments[path] ?? '',
      postedComment: stored.entries[path]?.postedComment ?? '',
      postedId: stored.entries[path]?.postedId ?? null,
      expectedSha: entry.expectedSha,
      actualSha: entry.actualSha,
    };
  }
  stored = { version: 2, entries: live };

  let pending = null;
  const flush = async () => {
    pending = null;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(stored, null, 2));
  };

  return {
    file,
    summary: { carried, reset },
    read: () => state,

    /** Comments never posted, or edited since they were. */
    unsentComments: () => state.unsent.map((path) => ({ path, body: state.comments[path] })),

    /** Called only after GitHub has accepted them, so a failure changes nothing. */
    markPosted(posted) {
      for (const { path, id } of posted) {
        const record = stored.entries[path];
        if (record) {
          record.postedComment = record.comment;
          record.postedId = id;
          if (id && !state.posted.includes(path)) {
            state.posted.push(path);
          }
        }
      }

      const paths = posted.map((entry) => entry.path);
      state.unsent = state.unsent.filter((path) => !paths.includes(path));
      if (!pending) {
        pending = setTimeout(flush, 200);
      }
    },

    /** The pull request comment behind a path, if one was ever published. */
    postedIdFor: (path) => stored.entries[path]?.postedId ?? null,

    /** Forgets a comment locally, and that it was ever on the pull request. */
    forgetComment(path) {
      const record = stored.entries[path];
      if (record) {
        record.comment = '';
        record.postedComment = '';
        record.postedId = null;
      }

      delete state.comments[path];
      state.stale = state.stale.filter((candidate) => candidate !== path);
      state.unsent = state.unsent.filter((candidate) => candidate !== path);
      state.posted = state.posted.filter((candidate) => candidate !== path);

      if (record && !record.viewed) {
        delete stored.entries[path];
      }
      if (!pending) {
        pending = setTimeout(flush, 200);
      }
    },
    /* A patch carries either one path or a list of them, because checking off a whole
       directory touches every screenshot in it and should still be a single write. */
    update(patch) {
      const paths = patch.paths ?? (patch.path ? [patch.path] : []);
      /* Only the paths that actually flipped are worth mirroring: a directory tick
         sends everything under it, most of which is already in that state. */
      const flipped = [];

      for (const path of paths) {
        const entry = current.get(path);
        if (!entry) {
          continue;
        }

        const record = stored.entries[path] ?? {
          viewed: false,
          comment: '',
          postedComment: '',
          postedId: null,
          expectedSha: entry.expectedSha,
          actualSha: entry.actualSha,
        };

        if (patch.viewed !== undefined) {
          if (record.viewed !== Boolean(patch.viewed)) {
            flipped.push(path);
          }
          record.viewed = Boolean(patch.viewed);
          if (patch.viewed) {
            state.viewed[path] = true;
          } else {
            delete state.viewed[path];
          }
        }

        if (patch.comment !== undefined) {
          record.comment = patch.comment || '';
          if (patch.comment) {
            state.comments[path] = patch.comment;
          } else {
            delete state.comments[path];
          }
          /* Rewriting a comment on a changed screenshot settles it. */
          state.stale = state.stale.filter((candidate) => candidate !== path);

          state.unsent = state.unsent.filter((candidate) => candidate !== path);
          if (record.comment && record.comment !== record.postedComment) {
            state.unsent.push(path);
          }
        }

        /* Anything touched now is judged against what is on screen now. */
        record.expectedSha = entry.expectedSha;
        record.actualSha = entry.actualSha;

        if (record.viewed || record.comment || record.postedId) {
          stored.entries[path] = record;
        } else {
          delete stored.entries[path];
        }
      }

      if (!pending) {
        pending = setTimeout(flush, 200);
      }

      return { flipped };
    },
  };
};

const LOCAL_THROTTLE = 2000;
const REMOTE_THROTTLE = 30000;
/* Anonymous callers get sixty GitHub requests an hour, and the remote throttle alone
   would spend twice that. Five minutes leaves the budget for the review itself. */
const ANONYMOUS_THROTTLE = 300000;

/**
 * Answers whether the head has moved since the review was built, asked on load, on tab
 * focus and on every mark. Git or GitHub is asked at most once per throttle window: two
 * seconds for a local range, thirty for a pull request, five minutes signed out.
 * @param {{ args: Args, viewer: string | null, range: Range, cwd: string, reviewedAt: string }} options
 * @returns {{ check: (paths: string[], entries: Map<string, ReviewEntry>) => Promise<Freshness> }}
 */
const createFreshness = ({ args, viewer, range, cwd, reviewedAt }) => {
  const throttle = args.pr ? (viewer ? REMOTE_THROTTLE : ANONYMOUS_THROTTLE) : LOCAL_THROTTLE;
  let checkedAt = 0;
  let latest = reviewedAt;

  const resolveLatest = async () => {
    if (Date.now() - checkedAt < throttle) {
      return latest;
    }
    checkedAt = Date.now();

    try {
      latest = (args.pr ? await headOfPullRequest(args.pr, cwd) : await resolveRef(range.head, cwd)) ?? latest;
    } catch {
      /* Offline, or gh is unhappy. Staying on the last answer is better than
         interrupting a review with an error it cannot act on. */
    }

    return latest;
  };

  return {
    /**
     * Returns whether the head has moved and, of the paths given, which ones the
     * newer commit actually changed.
     */
    async check(paths, entries) {
      const head = await resolveLatest();

      if (!head || head === reviewedAt) {
        return { moved: false };
      }

      const shas = await blobShasAt(head, paths, cwd).catch(() => new Map());
      const changed = paths.filter((path) => {
        const entry = entries.get(path);
        /* A path the new commit does not have counts as changed: it was deleted. */
        return entry ? shas.get(path) !== entry.actualSha : false;
      });

      return { moved: true, head, changed };
    },
  };
};

/*
 * The generated diff for a pair is decided entirely by the two images, so it is
 * cached under their hashes rather than under the commits they came from.
 *
 * Keying by commit meant a push that rewrote four screenshots invalidated all two
 * thousand, which is what made refreshing cost a full rebuild. By content, a refresh
 * recomputes only what actually moved, and the cache dedupes across pushes, across
 * pull requests, and across the many snapshots that are byte-identical to each other.
 *
 * Sharded two characters deep, the way git stores its own objects, so no single
 * directory ends up with tens of thousands of entries.
 */
const DIFF_CACHE = 'diffs';

/**
 * Where a pair's diff image and metrics are cached, keyed by the two blob ids.
 * @param {string} root From `stateDir`.
 * @param {string} expectedSha
 * @param {string} actualSha
 * @returns {{ dir: string, png: string, meta: string }}
 */
const diffCachePaths = (root, expectedSha, actualSha) => {
  const dir = join(root, DIFF_CACHE, expectedSha.slice(0, 2));
  const stem = join(dir, `${expectedSha}-${actualSha}`);
  return { dir, png: `${stem}.png`, meta: `${stem}.json` };
};

/**
 * Reads both sides of every screenshot and diffs each comparable pair, reusing any diff
 * already cached for those two blobs.
 * @param {object} options
 * @param {ManifestEntry[]} options.entries
 * @param {BlobReader} options.reader
 * @param {string} options.mergeBase
 * @param {string} options.head
 * @param {string} options.cacheRoot
 * @returns {Promise<{ entries: ReviewEntry[], diffs: Map<string, string>, computed: number, reused: number }>}
 * `diffs` maps a path to its cached diff image.
 */
const buildDiffs = async ({ entries, reader, mergeBase, head, cacheRoot }) => {
  const results = {};
  const diffs = new Map();

  let done = 0;
  let computed = 0;
  let reused = 0;

  for (const entry of entries) {
    /* A renamed screenshot's baseline is still under its old path. */
    const expected = entry.status === 'A' ? null : await reader.read(mergeBase, entry.oldPath ?? entry.path);
    const actual = entry.status === 'D' ? null : await reader.read(head, entry.path);
    const comparable = Boolean(expected && actual && entry.expectedSha && entry.actualSha);

    let record = null;

    if (comparable) {
      const paths = diffCachePaths(cacheRoot, entry.expectedSha, entry.actualSha);

      record = await readFile(paths.meta, 'utf8')
        .then(JSON.parse)
        .catch(() => null);

      if (record) {
        /* Touched so that a pair still in use is not swept for being old. */
        const now = new Date();
        await Promise.all([utimes(paths.png, now, now).catch(() => {}), utimes(paths.meta, now, now).catch(() => {})]);
        reused++;
      } else {
        const compared = comparePng(expected, actual);
        record = {
          ratio: compared.ratio,
          changed: compared.changed,
          resized: compared.resized,
          size: compared.size,
          expectedSize: compared.expectedSize,
          actualSize: compared.actualSize,
        };

        await mkdir(paths.dir, { recursive: true });
        await writeFile(paths.png, compared.png);
        await writeFile(paths.meta, JSON.stringify(record));
        computed++;
      }

      diffs.set(entry.path, paths.png);
    }

    results[entry.path] = {
      ...entry,
      comparable,
      size: record?.size ?? pngSize(actual ?? expected),
      expectedSize: record?.expectedSize ?? (expected ? pngSize(expected) : null),
      actualSize: record?.actualSize ?? (actual ? pngSize(actual) : null),
      ratio: record?.ratio ?? null,
      changed: record?.changed ?? null,
      resized: record?.resized ?? false,
      bytes: { expected: expected?.length ?? null, actual: actual?.length ?? null },
    };

    done++;
    if (computed && done % 50 === 0) {
      process.stdout.write(`\r  diffing ${done}/${entries.length}`);
    }
  }

  if (computed) {
    process.stdout.write(`\r  diffed ${computed} pairs${' '.repeat(24)}\n`);
  }

  return { entries: Object.values(results), diffs, computed, reused };
};

/**
 * Writes a complete response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string | Buffer} body
 * @param {Record<string, string>} [headers]
 */
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
};

/**
 * Reads a request body as JSON.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>} An empty object for an empty body.
 */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

/**
 * Listens on `port`, moving up a port at a time while it is taken, to at most 20 above
 * the default.
 * @param {import('node:http').Server} server
 * @param {number} port
 * @returns {Promise<number>} The port it got.
 */
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    /* A failed attempt's listener has to go too, or it fires when the next port
       succeeds and reports the busy one. */
    const onError = (error) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' && port < DEFAULT_PORT + 20) {
        listen(server, port + 1).then(resolve, reject);
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

const CACHE_TTL_DAYS = 14;

/**
 * Deletes cached diffs unused for 14 days, and anything left from the old commit-keyed
 * layout. Review state files are never touched, since they cannot be regenerated.
 * @param {string} root From `stateDir`.
 * @returns {Promise<number>} How many entries were removed.
 */
const pruneCache = async (root) => {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let freed = 0;

  /* Anything at the top level that is not the shared cache or a review's state is a
     leftover from the commit-keyed layout, which nothing can read any more. */
  for (const name of await readdir(root).catch(() => [])) {
    if (name === DIFF_CACHE || name.endsWith('.json')) {
      continue;
    }
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    freed++;
  }

  const cacheDir = join(root, DIFF_CACHE);

  for (const shard of await readdir(cacheDir).catch(() => [])) {
    const shardDir = join(cacheDir, shard);
    const names = await readdir(shardDir).catch(() => []);
    let left = names.length;

    for (const name of names) {
      const path = join(shardDir, name);
      const info = await stat(path).catch(() => null);

      if (!info || info.mtimeMs >= cutoff) {
        continue;
      }

      await rm(path, { force: true }).catch(() => {});
      left--;
      /* Counted in pairs, since each diff is an image and its metrics. */
      if (name.endsWith('.png')) {
        freed++;
      }
    }

    if (left === 0) {
      await rm(shardDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return freed;
};

/**
 * Builds everything the server answers from, as one value that refresh swaps whole.
 * Every blob is read at the resolved head, so a moving branch cannot mix two commits.
 * @param {{ args: Args, viewer: string | null, range: Range, pathspec: string, cwd: string, reader: BlobReader }} options
 * @returns {Promise<Review>}
 */
const buildReview = async ({ args, viewer, range, pathspec, cwd, reader }) => {
  const manifest = await buildManifest({ base: range.base, head: range.head, pathspec, cwd });
  if (manifest.entries.length === 0) {
    throw new Error(`No screenshots changed between ${range.base} and ${range.head}`);
  }

  const headSha = await resolveRef(range.head, cwd);
  const root = await stateDir(cwd);

  /* Read at the head, because the spec that took a screenshot is the one on the branch,
     not whatever the working tree happens to be checked out to. */
  await attachTests({ entries: manifest.entries, ref: headSha, cwd });

  const { entries, diffs, computed, reused } = await buildDiffs({
    entries: manifest.entries,
    reader,
    mergeBase: manifest.mergeBase,
    head: headSha,
    cacheRoot: root,
  });

  const store = await createStore(cwd, reviewKey(args, range), entries);
  const pruned = await pruneCache(root);

  /* What teammates have already said, so their notes sit beside the screenshot they
     are about. A failure here is not worth refusing to start over.
     Narrowed to this range: a pull request collects comments on source files too, and
     those have nowhere to appear here. */
  const allThreads = args.pr ? await fetchReviewThreads({ number: args.pr, cwd }).catch(() => ({})) : {};
  const inRange = new Set(entries.map((entry) => entry.path));
  const threads = Object.fromEntries(Object.entries(allThreads).filter(([path]) => inRange.has(path)));

  /* Links are only offered for commits GitHub can actually serve. */
  const slug = await remoteSlug(cwd);
  const blobBase = slug
    ? {
        repo: slug,
        expected: (await isOnRemote(manifest.mergeBase, cwd)) ? manifest.mergeBase : null,
        actual: (await isOnRemote(headSha, cwd)) ? headSha : null,
      }
    : null;

  return {
    threads,
    blobBase,
    pruned,
    computed,
    reused,
    headSha,
    mergeBase: manifest.mergeBase,
    entries,
    diffs,
    store,
    counts: entries.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {}),
    /* The client only ever knows a screenshot by its current path, so the server
       keeps the mapping back to where a renamed one's baseline lives. */
    baselinePaths: new Map(entries.filter((entry) => entry.oldPath).map((entry) => [entry.path, entry.oldPath])),
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
    pushWatch: createFreshness({ args, viewer, range, cwd, reviewedAt: headSha }),
  };
};

/**
 * Finds the checkout to review: `--repo`, else ionic-framework cloned next to the
 * reviewer, else whatever path the developer types in.
 * @param {Args} args
 * @returns {Promise<string>} The checkout's root.
 */
const findRepo = async (args) => {
  const reviewer = await repoRoot(HERE).catch(() => null);
  /** @param {string} path */
  const check = async (path) => {
    const root = await repoRoot(path).catch(() => null);
    if (!root) {
      return { error: `Not a git repository: ${path}` };
    }
    if (root === reviewer) {
      return { error: 'That is the reviewer itself, not ionic-framework' };
    }
    return { root };
  };

  if (args.repo) {
    const { root, error } = await check(args.repo);
    if (error) {
      throw new Error(`${error}. Pass --repo <path to ionic-framework>.`);
    }
    return root;
  }

  const { root: sibling } = await check(join(dirname(HERE), '..', 'ionic-framework'));
  if (sibling) {
    return sibling;
  }

  if (!stdin.isTTY) {
    throw new Error('No ionic-framework next to the reviewer. Pass --repo <path to ionic-framework>.');
  }

  /* Pasted or dragged in, a path can arrive quoted, and the shell is not there to
     expand a leading ~. */
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('\n  No ionic-framework found next to the reviewer.\n');
    for (;;) {
      const answer = (await prompt.question('  Path to your ionic-framework checkout: '))
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .replace(/^~(?=$|\/)/, homedir());
      if (answer) {
        const { root, error } = await check(resolve(answer));
        if (root) {
          return root;
        }
        stdout.write(`  ${error}\n`);
      }
    }
  } finally {
    prompt.close();
  }
};

/** Parses the arguments, builds the review and serves it until interrupted. */
export const main = async () => {
  const args = readArgs();
  if (args.help) {
    process.stdout.write(usage);
    return;
  }

  const cwd = await findRepo(args);

  /* Writing to a pull request is done as whoever gh is logged in as. With no account
     there is nobody to post as, so the review runs read-only rather than failing on
     each attempt. */
  const viewer = await authenticatedUser(cwd);
  if (args.pr && !viewer) {
    process.stdout.write(`\n${NO_ACCOUNT}\n`);
  }

  let range = await resolveRange(args, cwd);
  const pathspec = args.path ?? DEFAULT_PATHSPEC;

  const reader = new BlobReader(cwd);
  let review = await buildReview({ args, viewer, range, pathspec, cwd, reader });

  /* sirv handles static assets, including the slider web component served straight
     out of node_modules, so nothing has to be copied or bundled. */
  const serveClient = sirv(CLIENT_DIR, { dev: true, etag: true });
  const serveSlider = sirv(SLIDER_PKG, { maxAge: 31536000, immutable: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'POST' && url.pathname === '/api/comments/publish') {
        /* Only a pull request has somewhere to post to. A ref range does not. */
        if (!args.pr) {
          return send(
            res,
            400,
            JSON.stringify({ error: 'Comments can only be posted when reviewing a pull request.' }),
            {
              'content-type': 'application/json',
            }
          );
        }

        if (!viewer) {
          return send(res, 400, JSON.stringify({ error: 'No GitHub account. Run gh auth login to post comments.' }), {
            'content-type': 'application/json',
          });
        }

        const comments = review.store.unsentComments();
        if (comments.length === 0) {
          return send(res, 200, JSON.stringify({ ok: true, count: 0 }), { 'content-type': 'application/json' });
        }

        const { dryRun } = await readBody(req).catch(() => ({}));
        const result = await publishComments({ number: args.pr, comments, cwd, dryRun: Boolean(dryRun) });

        /* Marked only once GitHub has them, so a failure leaves everything unsent. */
        if (!dryRun) {
          review.store.markPosted(result.posted ?? []);
        }

        return send(res, 200, JSON.stringify({ ok: true, ...result }), { 'content-type': 'application/json' });
      }

      if (req.method === 'POST' && url.pathname === '/api/comments/delete') {
        const { path } = await readBody(req);
        const postedId = review.store.postedIdFor(path);

        /* Removed from the pull request first. If that fails the local note stays, so
           the two never disagree about what is published. */
        if (postedId) {
          if (!args.pr || !viewer) {
            return send(
              res,
              400,
              JSON.stringify({ error: 'No GitHub account to delete this from the pull request.' }),
              {
                'content-type': 'application/json',
              }
            );
          }
          await deleteComment({ id: postedId, cwd });
        }

        review.store.forgetComment(path);

        return send(res, 200, JSON.stringify({ ok: true, wasPosted: Boolean(postedId) }), {
          'content-type': 'application/json',
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        if (args.pr) {
          await git(['fetch', 'origin', `pull/${args.pr}/head`], cwd).catch(() => {});
        }

        /*
         * The range is resolved again, not reused.
         *
         * A pull request's head was pinned to a commit id when the server started, so
         * rebuilding against the old range would faithfully rebuild the old review and
         * report success. Refresh exists precisely to move to the newer push.
         */
        range = await resolveRange(args, cwd);

        /* Built into a local first, so a failure leaves the running review intact and
           the reviewer keeps whatever they were looking at. */
        const rebuilt = await buildReview({ args, viewer, range, pathspec, cwd, reader });
        review = rebuilt;

        return send(res, 200, JSON.stringify({ ok: true, head: review.headSha }), {
          'content-type': 'application/json; charset=utf-8',
        });
      }

      if (url.pathname === '/api/freshness') {
        /* Marking is no longer the only way to notice a push: a reviewer who has
           finished marking would never have asked the question otherwise. */
        const freshness = await review.pushWatch.check([], review.byPath).catch(() => ({ moved: false }));

        return send(res, 200, JSON.stringify(freshness), { 'content-type': 'application/json' });
      }

      if (req.method === 'POST' && url.pathname === '/api/state') {
        const patch = await readBody(req);
        const { flipped } = review.store.update(patch);

        /*
         * Mirrored onto the pull request so its Files tab agrees with what was ticked
         * here, rather than the reviewer keeping two tallies.
         *
         * Awaited, because a tick that silently failed to reach GitHub is worse than
         * one that takes a moment. Only viewed changes go; a comment is published
         * deliberately through its own button.
         */
        let mirrored = null;
        if (args.pr && viewer && patch.viewed !== undefined && flipped.length > 0) {
          mirrored = await setFilesViewed({ number: args.pr, paths: flipped, viewed: patch.viewed, cwd })
            .then(({ marked, refused }) => ({ ok: refused.length === 0, marked, refused }))
            .catch((error) => ({ ok: false, error: error.message, refused: [] }));
        }

        /* The mark is recorded either way. Whether it still applies is the separate
           question answered here, against the paths the mark actually touched. */
        const touched = patch.paths ?? (patch.path ? [patch.path] : []);
        const freshness = await review.pushWatch.check(touched, review.byPath).catch(() => ({ moved: false }));

        return send(res, 200, JSON.stringify({ ok: true, freshness, mirrored }), {
          'content-type': 'application/json',
        });
      }

      if (url.pathname === '/api/manifest') {
        return send(
          res,
          200,
          JSON.stringify({
            range: { ...range, mergeBase: review.mergeBase, pathspec },
            /* The client hides the publish control without one. */
            pr: args.pr ?? null,
            prState: range.prState,
            viewer,
            blobBase: review.blobBase,
            threads: review.threads,
            head: review.headSha,
            counts: review.counts,
            entries: review.entries,
            state: review.store.read(),
            carriedOver: review.store.summary,
          }),
          { 'content-type': 'application/json; charset=utf-8' }
        );
      }

      if (url.pathname === '/blob') {
        const path = url.searchParams.get('path');
        const side = url.searchParams.get('side');

        /* The diff is generated, so it comes off disk. Expected and actual are the
           originals, read straight out of the object store. */
        const blob =
          side === 'diff'
            ? review.diffs.has(path)
              ? await readFile(review.diffs.get(path))
              : null
            : path
              ? await reader.read(
                  side === 'expected' ? review.mergeBase : review.headSha,
                  side === 'expected' ? (review.baselinePaths.get(path) ?? path) : path
                )
              : null;

        if (!blob) {
          return send(res, 404, 'not found');
        }
        return send(res, 200, blob, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
        });
      }

      if (url.pathname.startsWith('/vendor/')) {
        req.url = url.pathname.slice('/vendor'.length);
        return serveSlider(req, res, () => send(res, 404, 'not found'));
      }

      serveClient(req, res, () => send(res, 404, 'not found'));
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), { 'content-type': 'application/json' });
    }
  });

  const port = await listen(server, Number(args.port));
  const address = `http://localhost:${port}`;

  const withRatio = review.entries.filter((entry) => entry.ratio !== null);
  const biggest = withRatio.reduce((max, entry) => Math.max(max, entry.ratio), 0);

  const orphaned = review.entries.filter((entry) => entry.orphaned);

  process.stdout.write(
    [
      ``,
      `  Snapshot review  ${range.label}`,
      `  ${review.entries.length} screenshots  ${review.counts.M ?? 0} modified, ${review.counts.A ?? 0} added, ` +
        `${review.counts.D ?? 0} removed` +
        (review.counts.R ? `, ${review.counts.R} renamed` : ''),
      `  ${withRatio.length} diffed  largest change ${(biggest * 100).toFixed(2)}% of pixels`,
      `  base ${review.mergeBase.slice(0, 10)} (merge base)`,
      ...(review.store.summary.reset
        ? [`  ${review.store.summary.reset} reset, changed since they were reviewed`]
        : []),
      ...(review.reused ? [`  ${review.reused} diffs reused from cache, ${review.computed} computed`] : []),
      ...(Object.keys(review.threads).length
        ? [`  ${Object.keys(review.threads).length} screenshots already have review comments`]
        : []),
      ...(review.pruned ? [`  ${review.pruned} stale cache ${review.pruned === 1 ? 'entry' : 'entries'} removed`] : []),
      ...(orphaned.length
        ? [
            `  ${orphaned.length} with no test, in ${new Set(orphaned.map((entry) => entry.group)).size} ` +
              `${new Set(orphaned.map((entry) => entry.group)).size === 1 ? 'directory' : 'directories'}:`,
            ...[...new Set(orphaned.map((entry) => entry.group))].map((group) => `    ${group}`),
          ]
        : []),
      ``,
      ...(args.pr && !viewer ? [NO_ACCOUNT, ``] : []),
      `  ${address}`,
      ``,
    ].join('\n')
  );

  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [address], () => {});
  }

  const shutdown = () => {
    reader.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};
