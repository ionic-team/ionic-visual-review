/**
 * Writes a review as a static site, for hosting where there is no clone to read from.
 *
 * The page is the same one the server sends. What it loses is everything that needs
 * the server: viewed marks stay in the browser, comments are read only, and a newer
 * push is noticed by reading head.json again.
 *
 * - Takes a range, never a pull request. Whoever runs it already knows both commits,
 *   and the export never contacts GitHub.
 * - A --url naming a pull request is where the page loads comments from, through
 *   GitHub's public API when it opens. Any other --url is only the header link.
 * - Images are named by blob id and diffs by the pair, so two screenshots with the
 *   same bytes are written once.
 * - Replaces an earlier export in --out, but refuses a folder holding anything else,
 *   since --out can be any path.
 * - A range with no changed screenshots writes nothing and still succeeds, so a
 *   workflow can run it on every push and skip the deploy when the folder is missing.
 *
 * Usage:
 *   npm run export -- --base origin/main --head my-branch
 *   npm run export -- --repo ~/code/ionic-framework --base <sha> --head <sha> --out dist
 *   npm run export -- --base <sha> --head <sha> --label '#31321 fix(item): ...' --url <pull request>
 */
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BlobReader, DEFAULT_PATHSPEC } from './git.mjs';
import { CLIENT_DIR, SLIDER_PKG, buildSnapshots, findRepo, resolveRange } from './index.mjs';

const usage = `
Write a review as a static site.

  --repo <path>     The ionic-framework checkout to read. Defaults to
                    ../ionic-framework next to the reviewer.
  --base <ref>      Compare from this ref. Required.
  --head <ref>      Compare to this ref. Required.
  --path <spec>     Narrow the set with a git pathspec.
  --out <dir>       Where to write the site. Defaults to dist.
  --label <text>    The header title. Defaults to the two refs.
  --url <url>       Where the header title links to. A pull request's URL
                    also shows its comments.
`;

/**
 * A folder as typed when it is under the current directory, and in full otherwise.
 * @param {string} dir
 * @returns {string}
 */
const shown = (dir) => {
  const path = relative(process.cwd(), dir);
  return path && !path.startsWith('..') ? path : dir;
};

/**
 * The pull request a --url points at, for the page to load comments from.
 * @param {string | undefined} url
 * @returns {{ repo: string, number: number } | null} Null for any other URL.
 */
const pullRequestOf = (url) => {
  const match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
};

/**
 * Whether a folder holds an earlier export, the only thing replaced without asking.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
const isExport = async (dir) => {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).static === true;
  } catch {
    return false;
  }
};

/**
 * Parses the command line after `export`.
 * @param {string[]} argv
 */
const readArgs = (argv) =>
  parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      path: { type: 'string' },
      out: { type: 'string', default: 'dist' },
      label: { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;

/**
 * Builds the review for a range and writes it to `--out` as a static site.
 * @param {string[]} argv The arguments after `export`.
 * @returns {Promise<void>}
 */
export const exportSite = async (argv) => {
  const args = readArgs(argv);
  if (args.help) {
    process.stdout.write(usage);
    return;
  }

  if (!args.base || !args.head) {
    throw new Error('Pass both --base <ref> and --head <ref>.');
  }

  const out = resolve(args.out);
  const replacing = (await readdir(out).catch(() => [])).length > 0;
  if (replacing && !(await isExport(out))) {
    throw new Error(`${shown(out)} has files that are not an export. Pass an empty --out.`);
  }

  const cwd = await findRepo(args);
  const range = await resolveRange({ base: args.base, head: args.head }, cwd);
  const pathspec = args.path ?? DEFAULT_PATHSPEC;

  /* Cleared before building, so a range with nothing to show leaves no folder instead
     of the last review. */
  if (replacing) {
    await rm(out, { recursive: true, force: true });
  }

  const reader = new BlobReader(cwd);

  try {
    const snapshots = await buildSnapshots({ range, pathspec, cwd, reader });

    if (!snapshots) {
      process.stdout.write(`\n  No screenshots changed between ${range.base} and ${range.head}. Nothing written.\n\n`);
      return;
    }

    await mkdir(join(out, 'images'), { recursive: true });
    await mkdir(join(out, 'diffs'), { recursive: true });
    await mkdir(join(out, 'vendor'), { recursive: true });

    await cp(CLIENT_DIR, out, { recursive: true });
    /* Only what the page loads, not the package's type declarations and source maps. */
    for (const file of ['index.js', 'styles.css']) {
      await copyFile(join(SLIDER_PKG, file), join(out, 'vendor', file));
    }

    for (const sha of snapshots.shas) {
      await writeFile(join(out, 'images', `${sha}.png`), await reader.readSha(sha));
    }
    for (const [key, file] of snapshots.diffs) {
      await copyFile(file, join(out, 'diffs', `${key}.png`));
    }

    await writeFile(
      join(out, 'manifest.json'),
      JSON.stringify({
        static: true,
        range: {
          ...range,
          label: args.label ?? range.label,
          url: args.url ?? null,
          mergeBase: snapshots.mergeBase,
          pathspec,
        },
        blobBase: snapshots.blobBase,
        pullRequest: pullRequestOf(args.url),
        head: snapshots.headSha,
        counts: snapshots.counts,
        entries: snapshots.entries,
      })
    );
    /* Polled for a newer push. Kept apart from the manifest so that question costs a
       few bytes instead of the whole list. */
    await writeFile(join(out, 'head.json'), JSON.stringify({ head: snapshots.headSha }));

    process.stdout.write(
      [
        ``,
        `  Exported ${snapshots.entries.length} screenshots to ${shown(out)}`,
        `  ${snapshots.shas.size} images, ${snapshots.diffs.size} diffs`,
        ``,
        ``,
      ].join('\n')
    );
  } finally {
    reader.close();
  }
};
