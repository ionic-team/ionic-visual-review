/* Comment box, teammate threads, publishing and deleting. */
import { dom } from './dom.js';
import { refreshRow } from './list.js';
import { state } from './state.js';
import { persist } from './sync.js';

/**
 * A screenshot's file name without the extension.
 * @param {string} path
 * @returns {string}
 */
export const fileOf = (path) =>
  path
    .split('/')
    .pop()
    .replace(/\.png$/, '');

/*
 * A comment arrives as GitHub's rendered markdown, which is somebody else's HTML, so
 * it is rebuilt here from an allowlist rather than trusted. Anything not on the list
 * is unwrapped, keeping its words and dropping the element, and every attribute is
 * discarded except an http(s) href.
 *
 * Images are deliberately absent: a comment that embeds one would otherwise have this
 * page fetch it, and the alt text is not worth the request.
 */
const ALLOWED_TAGS = new Set([
  'P',
  'BR',
  'CODE',
  'PRE',
  'A',
  'STRONG',
  'EM',
  'B',
  'I',
  'DEL',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'HR',
]);

/**
 * Rebuilds GitHub's rendered comment HTML from the allowlist. Other tags are unwrapped,
 * and only http(s) links survive.
 * @param {string | null} html
 * @returns {DocumentFragment}
 */
const sanitize = (html) => {
  const parsed = new DOMParser().parseFromString(html ?? '', 'text/html');
  const fragment = document.createDocumentFragment();

  const walk = (source, target) => {
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        target.append(node.textContent);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      if (!ALLOWED_TAGS.has(node.tagName)) {
        walk(node, target);
        continue;
      }

      const element = document.createElement(node.tagName.toLowerCase());

      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(href)) {
          element.href = href;
          element.target = '_blank';
          element.rel = 'noreferrer';
        }
      }

      walk(node, element);
      target.append(element);
    }
  };

  walk(parsed.body, fragment);
  return fragment;
};

/**
 * Shows teammates' comments on the selected screenshot, one box per thread. Read only,
 * since replies belong on GitHub.
 */
export const renderThreads = () => {
  const threads = state.threads[state.current] ?? [];
  dom.threads.hidden = threads.length === 0;

  if (threads.length === 0) {
    return;
  }

  const nodes = [];

  /* More than one conversation about the same screenshot is worth counting, since
     otherwise a second thread just looks like a late reply to the first. */
  if (threads.length > 1) {
    const heading = document.createElement('p');
    heading.className = 'threads-count';
    heading.textContent = `${threads.length} conversations on this screenshot`;
    nodes.push(heading);
  }

  for (const thread of threads) {
    const box = document.createElement('div');
    box.className = 'thread';
    box.classList.toggle('is-resolved', thread.resolved);

    /* Stated once for the thread, not repeated against every reply in it. */
    const tags = [thread.resolved ? 'resolved' : '', thread.outdated ? 'outdated' : ''].filter(Boolean);
    if (tags.length) {
      const tag = document.createElement('span');
      tag.className = 'thread-tag';
      tag.textContent = tags.join(', ');
      box.append(tag);
    }

    thread.comments.forEach((comment, index) => {
      const item = document.createElement('div');
      item.className = 'thread-comment';
      /* Replies sit under the comment they answer, so a conversation reads as one. */
      item.classList.toggle('is-reply', index > 0);

      const who = document.createElement('a');
      who.className = 'thread-author';
      who.href = comment.url;
      who.target = '_blank';
      who.rel = 'noreferrer';
      who.textContent = comment.mine ? `${comment.author} (you)` : comment.author;

      const body = document.createElement('div');
      body.className = 'thread-body';
      body.append(sanitize(comment.body));

      item.append(who, body);
      box.append(item);
    });

    nodes.push(box);
  }

  dom.threads.replaceChildren(...nodes);
};

/**
 * Shows Delete when there is a comment, labelled for the pull request when it is posted
 * there.
 */
export const renderDelete = () => {
  const path = state.current;
  const published = state.posted.has(path);
  const has = Boolean(state.comments.get(path)) || published;

  dom.deleteComment.hidden = !has;
  dom.deleteComment.textContent = published ? 'Delete from PR' : 'Delete';
  dom.deleteComment.title = published
    ? `Removes this comment from #${state.pr} as well as here`
    : 'Clears this comment';
};

/**
 * Clears the selected screenshot's comment. One already posted is deleted from the pull
 * request too, after confirming.
 * @returns {Promise<void>}
 */
export const deleteCurrentComment = async () => {
  const path = state.current;
  const published = state.posted.has(path);

  if (
    published &&
    !window.confirm(`Delete this comment from pull request #${state.pr}?\n\nIt is removed for everyone.`)
  ) {
    return;
  }

  dom.deleteComment.disabled = true;

  try {
    const result = await fetch('/api/comments/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((response) => response.json());

    if (!result?.ok) {
      throw new Error(result?.error ?? 'failed');
    }

    state.comments.delete(path);
    state.unsent.delete(path);
    state.posted.delete(path);
    state.stale.delete(path);

    dom.comment.value = '';
    dom.comment.classList.remove('stale');
    dom.commentState.textContent = '';
    refreshRow(path);
    renderPublish();
  } catch (error) {
    /* Reported on the status line, not the button's title: renderDelete rewrites that
       title on the way out, so a failure put there would vanish silently. */
    dom.commentState.textContent = `Could not delete: ${error.message ?? error}`;
  } finally {
    dom.deleteComment.disabled = false;
    renderDelete();
  }
};

/**
 * Shows the publish button with the number of unsent comments, when there is a pull
 * request and an account to post as.
 */
export const renderPublish = () => {
  const count = state.unsent.size;
  /* Comments still save here; posting them would land on a pull request nobody is
     reviewing any more. */
  const settled = state.prState === 'MERGED' || state.prState === 'CLOSED';
  dom.publish.hidden = !state.pr || !state.viewer || count === 0;
  dom.publish.disabled = settled;
  dom.publish.title = settled
    ? `#${state.pr} is ${state.prState.toLowerCase()}, so comments can't be posted to it`
    : '';
  dom.publish.textContent = `Post ${count} comment${count === 1 ? '' : 's'} to #${state.pr}`;
};

/**
 * Posts every unsent comment as one review, after confirming.
 * @returns {Promise<void>}
 */
export const publishComments = async () => {
  const count = state.unsent.size;
  const confirmed = window.confirm(
    `Post ${count} comment${count === 1 ? '' : 's'} to pull request #${state.pr}?\n\n` +
      'They publish together as one review, visible to everyone who can see the pull request.'
  );

  if (!confirmed) {
    return;
  }

  dom.publish.disabled = true;
  dom.publish.textContent = 'Posting…';

  try {
    const result = await fetch('/api/comments/publish', { method: 'POST' }).then((response) => response.json());
    if (!result?.ok) {
      throw new Error(result?.error ?? 'failed');
    }

    state.unsent.clear();
    renderPublish();

    if (result.url) {
      window.open(result.url, '_blank', 'noreferrer');
    }
  } catch (error) {
    dom.publish.disabled = false;
    dom.publish.textContent = 'Posting failed, try again';
    dom.publish.title = String(error.message ?? error);
  }
};

let commentTimer = null;

/** Saves the comment as it is typed, once typing pauses for 400 ms. */
export const wireComments = () => {
  dom.comment.addEventListener('input', () => {
    const path = state.current;
    const value = dom.comment.value;

    if (value.trim()) {
      state.comments.set(path, value);
    } else {
      state.comments.delete(path);
    }

    /* Rewriting settles it against what is on screen now. */
    state.stale.delete(path);
    dom.comment.classList.remove('stale');

    if (value.trim()) {
      state.unsent.add(path);
    } else {
      state.unsent.delete(path);
    }
    renderPublish();
    renderDelete();

    dom.commentState.textContent = 'Saving…';
    clearTimeout(commentTimer);
    commentTimer = setTimeout(async () => {
      await persist({ path, comment: value.trim() ? value : '' });
      dom.commentState.textContent = value.trim() ? 'Saved locally' : '';
      refreshRow(path);
    }, 400);
  });
};
