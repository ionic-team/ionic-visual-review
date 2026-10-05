# ionic-visual-review

Review Playwright snapshot changes for Ionic Framework pull requests. GitHub's Files tab won't render hundreds of binary files, so this serves every before and after pair straight from git, with four comparison views and viewed state that syncs to the pull request.

## Setup

Requires Node 24 or later and a local clone of [ionic-framework](https://github.com/ionic-team/ionic-framework).

The [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, is optional. It adds teammates' comments, posting comments and syncing viewed marks to the pull request. Without it, pull requests still open read-only and viewed marks stay local.

```sh
npm install
```

## Usage

The reviewer looks for ionic-framework next to this repository first. If your clone is somewhere else, pass `--repo`, or start without it and type the path when asked.

```sh
npm start -- --pr 31321
npm start -- --base origin/main --head my-branch
npm start -- --repo ~/code/ionic-framework --pr 31321
```

| Option                         |                                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| `--repo <path>`                | The ionic-framework checkout to review. Defaults to `../ionic-framework`. |
| `--pr <number>`                | Review a pull request.                                                    |
| `--base <ref>`, `--head <ref>` | Review a range instead of a pull request.                                 |
| `--path <spec>`                | Narrow the set with a git pathspec.                                       |
| `--port <number>`              | Defaults to 4300.                                                         |
| `--no-open`                    | Don't open a browser.                                                     |

Press <kbd>?</kbd> in the app for what each marker means and the keyboard shortcuts.

### Why it needs a local clone

The clone is where everything is read from:

- **Images** come out of git's object store, about 4,000 for a large sync in a second, with no checkout and no network. GitHub's API would mean thousands of downloads, and allows 60 an hour without an account.
- **The changes** come from one `git diff`, renames included. GitHub's pull request file list stops at 3,000 files.
- **Test links and orphans** come from reading the specs at the commit under review.
- **Review progress and the diff cache** are kept in the clone's `.git/snapshot-review/`.

## Linting

```sh
npm run lint           # ESLint and stylelint, then Prettier formats in place
npm run lint.fix       # the same, with ESLint and stylelint fixing what they can
npm run typecheck      # TypeScript checks the JavaScript through its JSDoc types
```

CI fails if `npm run lint` leaves a diff, so run it before pushing.

## Testing

```sh
npm test               # everything: test.spec, then test.e2e
npm run test.spec      # unit and integration, about a second
npm run test.e2e       # the app in a browser, about three seconds
```

The end-to-end tests need Playwright's Chromium once: `npx playwright install chromium`.

| Folder             | What it covers                                                          |
| ------------------ | ----------------------------------------------------------------------- |
| `test/unit`        | Pure functions: screenshot name parsing, formatting, browser sets.      |
| `test/integration` | The manifest and the viewed-state store, against a real git repository. |
| `test/e2e`         | The running app: listing, filters, marking viewed.                      |

Integration and end-to-end tests build a throwaway repository with one of every kind of change in `test/fixtures/repo.js`. A fake `gh` that always fails is first on `PATH`, so no test can reach GitHub.
