// ─────────────────────────────────────────────────────────────────────────────
//  renderer.js  –  All editor logic
//
//  Features:
//    • Save as plain .txt (markdown-lite + code fences for code blocks)
//    • Load most recent note on startup
//    • 400ms debounced auto-save
//    • Sidebar listing all notes — click to switch
//    • Always-on-top toggle via status bar click
//    • B/I/U/S formatting + Ctrl+B/I/U/N shortcuts
//    • New note (+) and delete (🗑) with correct sidebar updates
//    • Find in note — Ctrl+F, TreeWalker highlights, Prev/Next navigation
//    • Dynamic Syntax Highlighting — type /language then Enter or Space
//      to insert a highlighted code block (powered by lib/prism-bundle.js)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Element refs ──────────────────────────────────────────────────────────────
const editor       = document.getElementById('editor');
const fontSizeEl   = document.getElementById('font-size');
const statusEl     = document.getElementById('status-text');
const btnNew       = document.getElementById('btn-new');
const btnDelete    = document.getElementById('btn-delete');
const btnSidebar   = document.getElementById('btn-sidebar');
const btnClose     = document.getElementById('btn-close');
const btnMinimize  = document.getElementById('btn-minimize');
const btnMaximize  = document.getElementById('btn-maximize');
const btnSearch    = document.getElementById('btn-search');
const tabBar       = document.getElementById('tab-bar');
const sidebar      = document.getElementById('sidebar');
const notesList    = document.getElementById('notes-list');
const searchBar    = document.getElementById('search-bar');
const searchInput  = document.getElementById('search-input');
const searchCount  = document.getElementById('search-count');

// ── State ─────────────────────────────────────────────────────────────────────
let currentFilename = null;
let allNotes        = [];    // in-memory cache: [{ filename, content, mtime }]
let sidebarOpen     = false;
let saveTimer       = null;
// Search state
let searchOpen      = false;
let searchMarks     = [];    // all <mark> elements currently in the editor
let searchIndex     = -1;   // which mark is currently active
let statusTimer     = null;
// Undo stack for code-block deletions (X button)
const deletedBlocks = [];
// Tab bar: tracks opened notes as { filename }
let openTabs = [];

// ── Language aliases ──────────────────────────────────────────────────────────
// Maps the /trigger word the user types to the canonical language key
// used by Prism and stored in data-lang on the code block.
const LANG_ALIASES = {
  python:     'python',   py:         'python',
  javascript: 'javascript', js:       'javascript',
  typescript: 'typescript', ts:       'typescript',
  c:          'c',
  cpp:        'cpp',      'c++':      'cpp',
  java:       'java',
  bash:       'bash',     sh:         'bash',     shell: 'bash',
  json:       'json',
  sql:        'sql',
  go:         'go',       golang:     'go',
  rust:       'rust',     rs:         'rust',
  markdown:   'markdown', md:         'markdown',
  yaml:       'yaml',     yml:        'yaml',
  ruby:       'ruby',     rb:         'ruby',
  php:        'php',
};

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Code block HTML factory ───────────────────────────────────────────────────
/**
 * Returns the HTML string for a code block wrapper.
 * The initial code is stored in data-initial-code (URL-encoded) so
 * setupCodeBlock() can read it back without needing to parse innerHTML.
 */
function createCodeBlockHTML(lang, code) {
  const highlighted = (window.Prism && code)
    ? window.Prism.highlight(code, null, lang)
    : escHtml(code);
  const encoded = encodeURIComponent(code);
  return (
    `<div class="code-block" data-lang="${lang}" contenteditable="false">` +
      `<div class="code-block-header">` +
        `<span class="code-lang-label">${lang}</span>` +
        `<div class="code-header-actions">` +
          `<button class="code-copy-btn">Copy</button>` +
          `<button class="code-delete-btn" title="Delete block">✕</button>` +
        `</div>` +
      `</div>` +
      `<div class="code-block-body">` +
        `<pre class="code-pre language-${lang}">` +
          `<code class="language-${lang}">${highlighted}</code>` +
        `</pre>` +
        `<textarea class="code-textarea" spellcheck="false" ` +
                  `autocomplete="off" data-initial-code="${encoded}"></textarea>` +
      `</div>` +
    `</div>`
  );
}

// ── Code block setup ──────────────────────────────────────────────────────────
/**
 * Wire up a .code-block element: populate textarea from data-initial-code,
 * re-highlight on every keystroke, sync height, copy button.
 */
function setupCodeBlock(wrapper) {
  wrapper.dataset.wired = '1'; // sentinel so the MutationObserver won't double-wire

  const ta        = wrapper.querySelector('.code-textarea');
  const codeEl    = wrapper.querySelector('code');
  const copyBtn   = wrapper.querySelector('.code-copy-btn');
  const deleteBtn = wrapper.querySelector('.code-delete-btn');
  const lang      = wrapper.dataset.lang || 'text';

  // Restore code from the encoded attribute (set by createCodeBlockHTML or
  // loaded from textToHtml after parsing a code fence from disk).
  const initial = decodeURIComponent(ta.dataset.initialCode || '');
  if (initial) {
    ta.value = initial;
    rehighlight();
  }

  function rehighlight() {
    codeEl.innerHTML = window.Prism
      ? window.Prism.highlight(ta.value, null, lang)
      : escHtml(ta.value);
    syncHeight();
  }

  function syncHeight() {
    // Let the textarea shrink first so scrollHeight reflects real content height
    ta.style.height = '1px';
    ta.style.height = ta.scrollHeight + 'px';
    // Keep the pre at least as tall so the body height covers the textarea
    const pre = wrapper.querySelector('.code-pre');
    pre.style.minHeight = ta.style.height;
  }

  ta.addEventListener('input', () => {
    rehighlight();
    scheduleSave();
    scheduleSnap();
  });

  ta.addEventListener('keydown', ev => {
    // Tab → insert 4 spaces
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + 4;
      rehighlight();
    }
    // Escape → return focus to editor after this block
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      focusEditorAfterBlock(wrapper);
    }
    // ArrowDown on last line → move cursor to editor content after this block
    if (ev.key === 'ArrowDown') {
      if (!ta.value.slice(ta.selectionEnd).includes('\n')) {
        ev.preventDefault();
        ev.stopPropagation();
        focusEditorAfterBlock(wrapper);
      }
    }
    // ArrowUp on first line → move cursor to editor content before this block
    if (ev.key === 'ArrowUp') {
      if (!ta.value.slice(0, ta.selectionStart).includes('\n')) {
        ev.preventDefault();
        ev.stopPropagation();
        focusEditorBeforeBlock(wrapper);
      }
    }
  });

  // Sync horizontal scroll between textarea and pre
  ta.addEventListener('scroll', () => {
    const pre = wrapper.querySelector('.code-pre');
    pre.scrollTop  = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });

  // Copy button
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(ta.value).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      // Fallback for environments without clipboard API
      ta.select();
      document.execCommand('copy');
    });
  });

  // Delete button — removes the block and pushes to our undo stack (Ctrl+Z restores it)
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      ta.dataset.initialCode = encodeURIComponent(ta.value);
      const afterEl = wrapper.nextSibling;
      focusEditorAfterBlock(wrapper);
      deletedBlocks.push({ el: wrapper, afterEl });
      wrapper.remove();
      scheduleSave();
    });
  }

  // Initial height
  syncHeight();
}

// ── Init all code blocks ──────────────────────────────────────────────────────
/** Called after setting editor.innerHTML — wires up every .code-block found. */
function initCodeBlocks() {
  editor.querySelectorAll('.code-block').forEach(setupCodeBlock);
}

// ── Code block ↔ editor focus helpers ────────────────────────────────────────

function getNodeRect(node) {
  if (node.nodeType === Node.ELEMENT_NODE) return node.getBoundingClientRect();
  const r = document.createRange();
  r.selectNodeContents(node);
  return r.getBoundingClientRect();
}

function isOnLastVisualLine(range, el) {
  const rRect = range.getBoundingClientRect();
  // Zero-height rect means cursor is at a void node like <br> — treat as boundary
  if (rRect.height === 0) return true;
  return rRect.bottom >= getNodeRect(el).bottom - 2;
}

function isOnFirstVisualLine(range, el) {
  const rRect = range.getBoundingClientRect();
  if (rRect.height === 0) return true;
  return rRect.top <= getNodeRect(el).top + 2;
}

function focusEditorAfterBlock(block) {
  // Skip <br> gaps; if the next real sibling is also a code block, jump into it
  let sib = block.nextSibling;
  while (sib && sib.nodeName === 'BR') sib = sib.nextSibling;
  if (sib && sib.nodeType === Node.ELEMENT_NODE && sib.classList.contains('code-block')) {
    const ta = sib.querySelector('.code-textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(0, 0); }
    return;
  }

  editor.focus();
  const sel = window.getSelection();
  const rng = document.createRange();
  const next = block.nextSibling;
  if (next) {
    if (next.nodeType === Node.TEXT_NODE) rng.setStart(next, 0);
    else rng.setStartBefore(next);
  } else {
    rng.setStartAfter(block);
  }
  rng.collapse(true);
  sel.removeAllRanges();
  sel.addRange(rng);
}

function focusEditorBeforeBlock(block) {
  // Skip <br> gaps; if the previous real sibling is also a code block, jump into it
  let sib = block.previousSibling;
  while (sib && sib.nodeName === 'BR') sib = sib.previousSibling;
  if (sib && sib.nodeType === Node.ELEMENT_NODE && sib.classList.contains('code-block')) {
    const ta = sib.querySelector('.code-textarea');
    if (ta) { const len = ta.value.length; ta.focus(); ta.setSelectionRange(len, len); }
    return;
  }

  editor.focus();
  const sel = window.getSelection();
  const rng = document.createRange();
  const prev = block.previousSibling;
  if (prev) {
    if (prev.nodeType === Node.TEXT_NODE) rng.setStart(prev, prev.nodeValue.length);
    else rng.setStart(prev, prev.childNodes.length);
  } else {
    rng.setStart(editor, 0);
  }
  rng.collapse(true);
  sel.removeAllRanges();
  sel.addRange(rng);
}

/**
 * Ensure the editor has a trailing editable element after any final code block.
 * Without this, clicks and cursor positioning can fall inside the textarea.
 */
function ensureTrailingLine() {
  const last = editor.lastChild;
  if (last && last.nodeType === Node.ELEMENT_NODE && last.classList.contains('code-block')) {
    const trail = document.createElement('div');
    trail.appendChild(document.createElement('br'));
    editor.appendChild(trail);
  }
}

// ── Snap code blocks & images to line grid ───────────────────────────────────
/**
 * Adjust the bottom margin of every code block and image so their total
 * occupied height (offsetHeight + marginTop + marginBottom) is a multiple
 * of the editor's line-height in pixels.  This keeps the repeating ruled-
 * line background aligned with the text that follows.
 */
function snapToLineGrid() {
  const root   = document.documentElement;
  const fs     = parseFloat(getComputedStyle(root).getPropertyValue('--editor-fs'));
  const lh     = parseFloat(getComputedStyle(root).getPropertyValue('--line-height'));
  const gridPx = fs * lh;                      // one ruled-line interval
  if (!gridPx || gridPx < 4) return;           // safety guard

  editor.querySelectorAll('.code-block, .note-image').forEach(el => {
    // Reset any previous adjustment so measurements are clean
    el.style.marginBottom = '';

    const cs        = getComputedStyle(el);
    const mTop      = parseFloat(cs.marginTop)    || 0;
    const mBot      = parseFloat(cs.marginBottom) || 0;
    const total     = el.offsetHeight + mTop + mBot;
    const snapped   = Math.ceil(total / gridPx) * gridPx;
    const extra     = snapped - total;

    if (extra > 0.5) {                          // avoid sub-pixel noise
      el.style.marginBottom = (mBot + extra) + 'px';
    }
  });
}

let snapTimer = null;
function scheduleSnap() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(snapToLineGrid, 60);
}

// ── Code block trigger ────────────────────────────────────────────────────────
/**
 * Called from the editor keydown handler when Enter or Space is pressed.
 * Checks if the current "line" in the editor is exactly /language.
 * If so, replaces that line with a new syntax-highlighted code block.
 * Returns true if a code block was inserted (caller should return early).
 */
function tryInsertCodeBlock(e) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;

  const container   = range.startContainer;
  const cursorOffset = range.startOffset;

  // Don't trigger if the cursor is inside an existing code block
  if (container.nodeType === Node.TEXT_NODE &&
      container.parentElement &&
      container.parentElement.closest('.code-block')) return false;

  // ── Find the direct child of the editor that contains the cursor ──
  // In div-per-line mode each paragraph is a <div>; in pre-wrap / BR mode
  // the text sits directly in the editor as text nodes.
  let node = container;
  while (node && node.parentNode !== editor) node = node.parentNode;

  const lineEl = (node && node !== editor && node.nodeType === Node.ELEMENT_NODE)
    ? node : null;

  // ── Extract the text of just the current "line" ──
  // With white-space:pre-wrap, Electron may keep everything in one text node
  // separated by \n characters. We must look only at the text before the
  // cursor, starting from the last newline.
  let lineText = '';
  if (lineEl) {
    lineText = lineEl.textContent.trim();
  } else if (container.nodeType === Node.TEXT_NODE) {
    const beforeCursor = container.nodeValue.slice(0, cursorOffset);
    const lastNL = beforeCursor.lastIndexOf('\n');
    lineText = beforeCursor.slice(lastNL + 1).trim(); // text since last newline
  }

  // Must be exactly /language — nothing else on the line
  const m = lineText.match(/^\/([a-z+]+)$/i);
  if (!m) return false;

  const lang = LANG_ALIASES[m[1].toLowerCase()];
  if (!lang) return false;

  e.preventDefault();

  // ── Build code block and trailing blank line ──
  const tmp = document.createElement('div');
  tmp.innerHTML = createCodeBlockHTML(lang, '');
  const codeBlock = tmp.firstElementChild;
  const trail = document.createElement('div');
  trail.appendChild(document.createElement('br'));

  // ── Splice the trigger out of the DOM and insert the code block ──
  if (lineEl) {
    // Simple case: the trigger is an entire <div> line — just swap it out
    lineEl.replaceWith(codeBlock);
    codeBlock.insertAdjacentElement('afterend', trail);

  } else if (container.nodeType === Node.TEXT_NODE) {
    // Text-node case (pre-wrap / BR-separated lines):
    // Identify what to keep before and after the trigger text.
    const fullText = container.nodeValue;
    const beforeCursor = fullText.slice(0, cursorOffset);
    const lastNL = beforeCursor.lastIndexOf('\n');

    // Text before the trigger line (drop the separating \n too)
    const keepBefore = lastNL >= 0 ? fullText.slice(0, lastNL) : '';
    // Text after the cursor on this same text node
    const keepAfter  = fullText.slice(cursorOffset);

    // Insert new nodes after the container (in reverse order so each
    // call to .after() places the item immediately after container):
    if (keepAfter) container.after(document.createTextNode(keepAfter));
    container.after(trail);
    container.after(codeBlock);

    // Shrink or remove the original text node
    if (keepBefore) {
      container.nodeValue = keepBefore;
    } else {
      container.remove();
    }

  } else {
    // Fallback (shouldn't normally be reached)
    editor.appendChild(codeBlock);
    editor.appendChild(trail);
  }

  setupCodeBlock(codeBlock);
  setTimeout(() => {
    codeBlock.querySelector('.code-textarea').focus();
    snapToLineGrid();
  }, 10);
  scheduleSave();
  return true;
}

// ── Serialise editor → plain text ─────────────────────────────────────────────
/** "rgb(255, 107, 107)" / "#f66" / "#ff6b6b" → "#ff6b6b" (null if unparseable). */
function rgbToHex(value) {
  if (!value) return null;
  const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return '#' + rgb.slice(1, 4).map(n => (+n).toString(16).padStart(2, '0')).join('');
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
  return '#' + h.toLowerCase();
}

/** Explicit text color on an editor element (<font color> or style="color:"). */
function elementTextColor(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'font') return rgbToHex(el.getAttribute('color') || el.style.color);
  if (tag === 'span') return rgbToHex(el.style.color);
  return null;
}

/**
 * Walk the editor's DOM and produce plain text with:
 *   - **bold**, *italic*, __underline__, ~~strikethrough__ markdown markers
 *   - ```lang\ncode\n``` fences for code blocks
 * This replaces the old htmlToText(editor.innerHTML) approach so that code
 * blocks (which are not in innerHTML as plain text) are handled correctly.
 */
function editorToText() {
  const parts = [];
  const defaultColor = rgbToHex(getComputedStyle(editor).color);

  // Text color → {#rrggbb|text}. Wraps whatever walkNode emits for the element,
  // so it composes with bold/italic/highlight on the same node.
  function walk(node) {
    const color = node.nodeType === Node.ELEMENT_NODE ? elementTextColor(node) : null;
    if (color && color !== defaultColor) {
      parts.push(`{${color}|`);
      walkNode(node);
      parts.push('}');
    } else {
      walkNode(node);
    }
  }

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    // Code block → code fence
    if (node.classList && node.classList.contains('code-block')) {
      const lang = node.dataset.lang || '';
      const ta   = node.querySelector('.code-textarea');
      const code = ta ? ta.value : (node.querySelector('code')?.textContent || '');
      parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
      return;
    }

    // Images → custom marker
    if (tag === 'img') {
      if (node.src) parts.push(`![img](${node.src})`);
      return;
    }

    // Block elements → leading newline (browser wraps paragraphs in <div>)
    if (tag === 'div' || tag === 'p') parts.push('\n');
    if (tag === 'br') { parts.push('\n'); return; }

    // Inline formatting → markdown markers (wrap children)
    const isB = tag === 'strong' || tag === 'b';
    const isI = tag === 'em'     || tag === 'i';
    const isU = tag === 'u';
    const isS = tag === 's'      || tag === 'del';

    // User highlight spans → ==color:text== marker
    if (tag === 'span' && node.classList.contains('user-highlight')) {
      const color = node.style.background || node.style.backgroundColor || '#ffe066';
      parts.push(`==${color}:`);
      node.childNodes.forEach(walk);
      parts.push('==');
      return;
    }

    if (isB) parts.push('**');
    if (isI) parts.push('*');
    if (isU) parts.push('__');
    if (isS) parts.push('~~');

    node.childNodes.forEach(walk);

    if (isS) parts.push('~~');
    if (isU) parts.push('__');
    if (isI) parts.push('*');
    if (isB) parts.push('**');
  }

  editor.childNodes.forEach(walk);

  return listsToMarkdown(
    parts
      .join('')
      .replace(/ /g, ' ')      // editors sometimes insert non-breaking spaces
      .replace(/^\n+/, '')          // strip leading newlines
      .replace(/\n{3,}/g, '\n\n')   // collapse excessive blank lines
      .replace(/\n+$/, '')          // trailing newlines only: keep indentation and an empty list item's marker
  );
}

/** "• " / "☐ " / "☑ " at line start → "- " / "- [ ] " / "- [x] " (code fences untouched). */
function listsToMarkdown(text) {
  return text.split(/(```[\s\S]*?```)/g).map((part, i) => i % 2 ? part : part
    .replace(/^( *)• /gm, '$1- ')
    .replace(/^( *)☐ /gm, '$1- [ ] ')
    .replace(/^( *)☑ /gm, '$1- [x] ')).join('');
}

// ── Format conversion (used for loading notes from disk) ─────────────────────
/**
 * Convert plain text (markdown-lite + code fences) → HTML for the editor.
 * Code fences (```lang\ncode\n```) become .code-block HTML via
 * createCodeBlockHTML(). Regular text uses the same inline → html rules as
 * before, now extracted into the helper inlineToHtml().
 */
function inlineToHtml(text) {
  // Pull images out before HTML-escaping (data URLs contain characters that
  // would survive escaping fine, but the regex is cleaner on raw text).
  const imgSlots = [];
  text = text.replace(/!\[img\]\((data:[^)\s]+)\)/g, (_, src) => {
    const i = imgSlots.length;
    imgSlots.push(src);
    return `\x00img${i}\x00`;
  });

  // List markers: "- [ ] " / "- [x] " / "- " at line start → ☐ / ☑ / •
  text = text
    .replace(/^( *)- \[( |x)\] /gm, (_, ind, c) => ind + (c === 'x' ? '☑' : '☐') + ' ')
    .replace(/^( *)- /gm, '$1• ');

  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Markdown → HTML (order matters: ** before *)
  // Text color {#rrggbb|text}. Innermost first, so nested colors resolve correctly.
  const COLOR_RE = /\{(#[0-9a-fA-F]{6})\|([^{}]*)\}/g;
  for (let prev; prev !== html; ) {
    prev = html;
    html = html.replace(COLOR_RE, '<span class="user-color" style="color:$1">$2</span>');
  }

  html = html
    .replace(/==([\w#(),.\s]+?):([\s\S]*?)==/g,
      '<span class="user-highlight" style="background:$1">$2</span>')
    .replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]*?)__/g,      '<u>$1</u>')
    .replace(/~~([\s\S]*?)~~/g,      '<s>$1</s>')
    .replace(/\*([\s\S]*?)\*/g,      '<em>$1</em>')
    .replace(/\n/g,                  '<br>');

  // Restore images
  html = html.replace(/\x00img(\d+)\x00/g, (_, i) =>
    `<img class="note-image" src="${imgSlots[i]}">`
  );

  return html;
}

function textToHtml(text) {
  // Split on code fences, preserving order
  const FENCE = /```(\w*)\n([\s\S]*?)\n```/g;
  const parts  = [];
  let lastIndex = 0;
  let m;

  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(inlineToHtml(text.slice(lastIndex, m.index)));
    }
    const lang = LANG_ALIASES[m[1].toLowerCase()] || m[1].toLowerCase() || 'text';
    parts.push(createCodeBlockHTML(lang, m[2]));
    lastIndex = FENCE.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(inlineToHtml(text.slice(lastIndex)));
  }

  return parts.join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFilename() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    `note_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`
  );
}

/** Extract MM/DD date from filename like note_20260506_143022.txt */
function filenameToDate(filename) {
  const m = filename.match(/note_\d{4}(\d{2})(\d{2})_/);
  return m ? `${m[2]}/${m[1]}` : '??/??';
}

/** First non-empty line of plain text, stripped of markdown markers */
function firstLine(text) {
  return (text.split('\n').find(l => l.trim() && !l.trim().startsWith('```')) || '(empty)')
    .replace(/^\s*(?:- \[[ xX]\] |- |\d+\. )/, '')
    .replace(/\{#[0-9a-fA-F]{6}\|([^{}]*)\}/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();
}

/** Second non-empty line, if any */
function secondLine(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('```'));
  if (lines.length < 2) return '';
  return lines[1].replace(/^\s*(?:- \[[ xX]\] |- |\d+\. )/, '').replace(/\{#[0-9a-fA-F]{6}\|([^{}]*)\}/g, '$1').replace(/[*_~`]/g, '').trim();
}

function flashStatus(msg, ms = 1400) {
  clearTimeout(statusTimer);
  const wasAotOn = statusEl.classList.contains('aot-on');
  statusEl.textContent = msg;
  statusTimer = setTimeout(() => {
    setAotLabel(wasAotOn);
  }, ms);
}

// ── Always-on-top toggle ──────────────────────────────────────────────────────

function setAotLabel(isOn) {
  statusEl.textContent = isOn ? '● Always on Top' : '○ Floating off';
  statusEl.classList.toggle('aot-on',  isOn);
  statusEl.classList.toggle('aot-off', !isOn);
}

statusEl.addEventListener('click', async () => {
  const isNowOn = await window.notesAPI.toggleAlwaysOnTop();
  setAotLabel(isNowOn);
});

// Toggled from the global shortcut (Ctrl+Alt+T) in the main process
window.notesAPI.onAlwaysOnTopChanged(setAotLabel);

// ── Window control buttons ───────────────────────────────────────────────────
btnMinimize.addEventListener('click', () => {
  window.notesAPI.minimizeWindow();
});

btnMaximize.addEventListener('click', () => {
  window.notesAPI.maximizeWindow();
});

btnClose.addEventListener('click', async () => {
  clearTimeout(saveTimer);
  await flushCurrentNote();
  window.notesAPI.closeWindow();
});

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  notesList.innerHTML = '';

  if (allNotes.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:14px 12px;font-size:11px;color:#55555a;font-family:var(--font)';
    empty.textContent = 'No notes yet';
    notesList.appendChild(empty);
    return;
  }

  allNotes.forEach(note => {
    const item  = document.createElement('div');
    item.className = 'note-item' + (note.filename === currentFilename ? ' active' : '');

    const title = firstLine(note.content).slice(0, 22);
    const sub   = secondLine(note.content).slice(0, 24);
    const date  = filenameToDate(note.filename);

    item.innerHTML = `
      <div class="note-item-title">
        ${escHtml(title)} <span class="note-date">(${date})</span>
      </div>
      ${sub ? `<div class="note-item-sub">– ${escHtml(sub)}</div>` : ''}
    `;

    item.addEventListener('click', () => switchToNote(note));
    notesList.appendChild(item);
  });
}

async function switchToNote(note) {
  if (note.filename === currentFilename) return;

  // Save current before switching
  clearTimeout(saveTimer);
  await flushCurrentNote();

  currentFilename  = note.filename;
  editor.innerHTML = textToHtml(note.content);
  initCodeBlocks();
  ensureTrailingLine();
  snapToLineGrid();
  resetFormatButtons();
  ensureTab(currentFilename);
  renderTabs();
  renderSidebar();
  editor.focus();
}

btnSidebar.addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('open', sidebarOpen);
  btnSidebar.classList.toggle('active', sidebarOpen);
  if (sidebarOpen) renderSidebar();
});

// ── Tab bar ──────────────────────────────────────────────────────────────────

function ensureTab(filename) {
  if (!openTabs.find(t => t.filename === filename)) {
    openTabs.push({ filename });
  }
}

function removeTab(filename) {
  openTabs = openTabs.filter(t => t.filename !== filename);
}

function renderTabs() {
  tabBar.innerHTML = '';
  openTabs.forEach(tab => {
    const note = allNotes.find(n => n.filename === tab.filename);
    const label = note ? firstLine(note.content).slice(0, 20) : tab.filename.replace('.txt', '');

    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.filename === currentFilename ? ' active' : '');

    const span = document.createElement('span');
    span.className = 'tab-label';
    span.textContent = label || '(empty)';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeTab(tab.filename);
    });

    el.appendChild(span);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => {
      const note = allNotes.find(n => n.filename === tab.filename);
      if (note) switchToNote(note);
    });
    tabBar.appendChild(el);
  });
}

function closeTab(filename) {
  removeTab(filename);
  if (filename === currentFilename) {
    if (openTabs.length > 0) {
      const next = allNotes.find(n => n.filename === openTabs[openTabs.length - 1].filename);
      if (next) { switchToNote(next); return; }
    }
    if (allNotes.length > 0) {
      const fallback = allNotes.find(n => n.filename !== filename) || allNotes[0];
      ensureTab(fallback.filename);
      switchToNote(fallback);
      return;
    }
    editor.innerHTML = '';
    currentFilename = makeFilename();
    ensureTab(currentFilename);
  }
  renderTabs();
}

// ── Find in note ──────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk every text node inside the editor using TreeWalker, find all matches,
 * and wrap them in <mark class="highlight"> elements.
 * Code blocks are skipped — searching only covers plain text.
 */
function highlightMatches(query) {
  clearHighlights();
  if (!query.trim()) { updateSearchCount(); return; }

  const regex  = new RegExp(escapeRegex(query), 'gi');
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text nodes that live inside a code block
      if (node.parentElement && node.parentElement.closest('.code-block')) {
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach(textNode => {
    const text    = textNode.nodeValue;
    const matches = [...text.matchAll(regex)];
    if (matches.length === 0) return;

    const fragment = document.createDocumentFragment();
    let lastIndex  = 0;

    matches.forEach(match => {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const mark       = document.createElement('mark');
      mark.className   = 'highlight';
      mark.textContent = match[0];
      fragment.appendChild(mark);
      lastIndex = match.index + match[0].length;
    });

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode.replaceChild(fragment, textNode);
  });

  searchMarks = Array.from(editor.querySelectorAll('mark.highlight'));
  searchIndex = searchMarks.length > 0 ? 0 : -1;
  activateMark(searchIndex);
  updateSearchCount();
}

function clearHighlights() {
  editor.querySelectorAll('mark.highlight').forEach(mark => {
    mark.replaceWith(...mark.childNodes);
  });
  editor.normalize();
  searchMarks = [];
  searchIndex = -1;
}

function activateMark(index) {
  searchMarks.forEach((m, i) => m.classList.toggle('active', i === index));
  if (searchMarks[index]) {
    searchMarks[index].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function navigateMatch(dir) {
  if (searchMarks.length === 0) return;
  searchIndex = (searchIndex + dir + searchMarks.length) % searchMarks.length;
  activateMark(searchIndex);
  updateSearchCount();
}

function updateSearchCount() {
  if (!searchInput.value.trim()) { searchCount.textContent = ''; return; }
  if (searchMarks.length === 0)  { searchCount.textContent = 'No results'; return; }
  searchCount.textContent = `${searchIndex + 1} / ${searchMarks.length}`;
}

function openSearch() {
  searchOpen = true;
  searchBar.classList.add('open');
  btnSearch.classList.add('active');
  searchInput.focus();
  searchInput.select();
  if (searchInput.value.trim()) highlightMatches(searchInput.value);
}

function closeSearch() {
  searchOpen = false;
  searchBar.classList.remove('open');
  btnSearch.classList.remove('active');
  clearHighlights();
  searchCount.textContent = '';
  searchInput.value = '';
  editor.focus();
}

btnSearch.addEventListener('click', () => {
  searchOpen ? closeSearch() : openSearch();
});

searchInput.addEventListener('input', () => {
  highlightMatches(searchInput.value);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

document.getElementById('search-prev').addEventListener('click',  () => navigateMatch(-1));
document.getElementById('search-next').addEventListener('click',  () => navigateMatch(1));
document.getElementById('search-close').addEventListener('click', () => closeSearch());

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Saves the current note if its text changed since the last save.
 * Returns { wrote, headerChanged }: headerChanged is true when the tab/sidebar
 * labels (first two lines) differ or the note is new, so callers can skip
 * rebuilding the tab bar and sidebar on ordinary keystrokes.
 */
async function flushCurrentNote() {
  const result = { wrote: false, headerChanged: false };
  if (!currentFilename) return result;
  const content = editorToText();
  if (!content) return result;

  const idx = allNotes.findIndex(n => n.filename === currentFilename);
  const prev = idx >= 0 ? allNotes[idx].content : null;
  if (prev === content) return result;   // nothing to write

  await window.notesAPI.save(currentFilename, content);
  result.wrote = true;
  if (idx >= 0) {
    result.headerChanged = firstLine(prev) !== firstLine(content) ||
                           secondLine(prev) !== secondLine(content);
    allNotes[idx].content = content;
    allNotes[idx].mtime   = Date.now();
  } else {
    result.headerChanged = true;
    allNotes.unshift({ filename: currentFilename, content, mtime: Date.now() });
  }
  return result;
}

function scheduleSave() {
  // Don't save while search is active — the DOM contains <mark> tags
  if (searchOpen) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!currentFilename) currentFilename = makeFilename();
    const { wrote, headerChanged } = await flushCurrentNote();
    if (!wrote) return;
    if (headerChanged) {
      renderTabs();
      if (sidebarOpen) renderSidebar();
    }
    flashStatus('Saved  ·  Always on Top');
  }, 400);
}

editor.addEventListener('input', scheduleSave);

// ── Paste ─────────────────────────────────────────────────────────────────────
// Pasted web content keeps its structure and emphasis (bold / italic / underline /
// strikethrough, paragraphs, lists) but drops the page's own fonts, sizes, colours
// and backgrounds — those would clash with the app theme (e.g. black text on dark).
function htmlToNoteHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const SKIP   = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript', 'template',
                          'svg', 'img', 'picture', 'video', 'audio', 'iframe', 'canvas', 'button',
                          'input', 'select', 'textarea']);
  const BLOCK1 = new Set(['div', 'li', 'tr', 'section', 'article', 'header', 'footer', 'nav', 'main',
                          'aside', 'form', 'dd', 'dt', 'address', 'figure', 'figcaption', 'details', 'summary']);
  const BLOCK2 = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'pre', 'dl']);
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const out = [];
  let breaks = 2;                       // <br>s at the end of out (2 = start: no leading breaks)
  const brk = n => { while (breaks < n) { out.push('<br>'); breaks++; } };

  function emitText(text, f) {
    if (!text) return;
    let h = esc(text);
    if (f.s) h = `<s>${h}</s>`;
    if (f.u) h = `<u>${h}</u>`;
    if (f.i) h = `<em>${h}</em>`;
    if (f.b) h = `<strong>${h}</strong>`;
    out.push(h);
    breaks = 0;
  }

  function walk(node, f, pre) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (pre) {
        node.nodeValue.split('\n').forEach((line, i) => {
          if (i) { out.push('<br>'); breaks++; }
          emitText(line, f);
        });
        return;
      }
      let t = node.nodeValue.replace(/[ \t\r\n\f\u00a0]+/g, ' ');
      if (breaks > 0) t = t.replace(/^ /, '');   // no leading space at line start
      emitText(t, f);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    const st  = node.style || {};
    if (SKIP.has(tag) || st.display === 'none') return;
    if (tag === 'br') { out.push('<br>'); breaks++; return; }

    const weight = String(st.fontWeight || '');
    const deco   = String(st.textDecorationLine || st.textDecoration || '');
    const nf = {
      b: f.b || (/^(b|strong|h[1-6]|th)$/.test(tag) && weight !== 'normal' && weight !== '400') ||
         weight === 'bold' || weight === 'bolder' || +weight >= 600,
      i: f.i || tag === 'i' || tag === 'em' || st.fontStyle === 'italic',
      u: f.u || tag === 'u' || deco.includes('underline'),
      s: f.s || /^(s|strike|del)$/.test(tag) || deco.includes('line-through'),
    };

    if (BLOCK2.has(tag)) brk(2); else if (BLOCK1.has(tag)) brk(1);
    if (tag === 'li') {
      const parent = node.parentElement;
      const n = parent && parent.tagName.toLowerCase() === 'ol'
        ? Array.from(parent.children).indexOf(node) + 1 : 0;
      emitText(n ? `${n}. ` : '• ', {});
    }
    if ((tag === 'td' || tag === 'th') && node.previousElementSibling) emitText(' | ', {});

    node.childNodes.forEach(c => walk(c, nf, pre || tag === 'pre'));

    if (BLOCK2.has(tag)) brk(2); else if (BLOCK1.has(tag)) brk(1);
  }

  walk(doc.body, {}, false);
  while (out.length && out[out.length - 1] === '<br>') out.pop();
  return out.join('').replace(/ +<br>/g, '<br>');
}

editor.addEventListener('paste', e => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find(it => it.type.startsWith('image/'));
  if (!imageItem) {
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    if (!html && text == null) return;   // nothing readable: leave it to the browser
    e.preventDefault();
    const clean = html ? htmlToNoteHtml(html) : '';
    if (clean) document.execCommand('insertHTML', false, clean);
    else document.execCommand('insertText', false, (text || '').replace(/\r\n?/g, '\n'));
    scheduleSave();
    return;
  }

  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    const img = document.createElement('img');
    img.src       = evt.target.result;
    img.className = 'note-image';

    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      // Place cursor after the image
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
    scheduleSave();
    scheduleSnap();
  };
  reader.readAsDataURL(file);
});

// ── New note ──────────────────────────────────────────────────────────────────
btnNew.addEventListener('click', async () => {
  clearTimeout(saveTimer);
  await flushCurrentNote();

  editor.innerHTML = '';
  currentFilename  = makeFilename();
  resetFormatButtons();
  ensureTab(currentFilename);
  renderTabs();
  editor.focus();
  if (sidebarOpen) renderSidebar();
  flashStatus('New note');
});

// ── Delete note ───────────────────────────────────────────────────────────────
// ── Delete confirmation ───────────────────────────────────────────────────────
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmText    = document.getElementById('confirm-text');
const confirmCancel  = document.getElementById('confirm-cancel');
const confirmOk      = document.getElementById('confirm-ok');

/** Themed confirm dialog. Resolves true on Delete, false on Cancel / Esc / click outside. */
function confirmDelete(noteTitle) {
  return new Promise(resolve => {
    confirmText.textContent = `“${noteTitle}” will be permanently deleted. This can’t be undone.`;
    confirmOverlay.classList.add('open');
    confirmOverlay.setAttribute('aria-hidden', 'false');
    confirmCancel.focus();                       // safe default: Enter cancels

    function done(result) {
      confirmOverlay.classList.remove('open');
      confirmOverlay.setAttribute('aria-hidden', 'true');
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      confirmOverlay.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    const onOk      = () => done(true);
    const onCancel  = () => done(false);
    const onOutside = e => { if (e.target === confirmOverlay) done(false); };
    const onKey     = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Tab') {                // keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === confirmCancel ? confirmOk : confirmCancel).focus();
      }
    };
    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
    confirmOverlay.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey, true);
  });
}

btnDelete.addEventListener('click', async () => {
  // Empty, never-saved notes have nothing to lose — skip the prompt for those.
  const content = editorToText();
  if (content) {
    const title = firstLine(content).slice(0, 40);
    if (!(await confirmDelete(title))) { editor.focus(); return; }
  }

  clearTimeout(saveTimer);

  const deletedFilename = currentFilename;
  if (currentFilename) {
    await window.notesAPI.delete(currentFilename);
    allNotes = allNotes.filter(n => n.filename !== currentFilename);
    removeTab(deletedFilename);
  }

  if (openTabs.length > 0) {
    const nextTab = allNotes.find(n => n.filename === openTabs[openTabs.length - 1].filename);
    if (nextTab) {
      currentFilename  = nextTab.filename;
      editor.innerHTML = textToHtml(nextTab.content);
      initCodeBlocks();
      ensureTrailingLine();
    }
  } else if (allNotes.length > 0) {
    currentFilename  = allNotes[0].filename;
    editor.innerHTML = textToHtml(allNotes[0].content);
    initCodeBlocks();
    ensureTrailingLine();
    ensureTab(currentFilename);
  } else {
    editor.innerHTML = '';
    currentFilename  = makeFilename();
    ensureTab(currentFilename);
  }

  renderTabs();
  if (sidebarOpen) renderSidebar();
  editor.focus();
  flashStatus('Deleted');
});

// ── Font size ─────────────────────────────────────────────────────────────────
fontSizeEl.addEventListener('change', () => {
  const size = parseInt(fontSizeEl.value, 10);
  if (!isNaN(size) && size >= 8 && size <= 72) {
    editor.style.fontSize = size + 'px';
    // Update the CSS variable so ruled lines re-calculate their spacing
    document.documentElement.style.setProperty('--editor-fs', size + 'px');
    snapToLineGrid();
  }
});
fontSizeEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { fontSizeEl.blur(); editor.focus(); }
});

// ── Format buttons ────────────────────────────────────────────────────────────
// Pure manual toggles — clicking lights the button up, clicking again dims it.
// The cursor position never re-engages or disengages a button automatically.

const fmtState = { bold: false, italic: false, underline: false, strikeThrough: false };

function applyFormat(cmd) {
  editor.focus();

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    // Text is selected: just apply the format, don't touch button state.
    document.execCommand(cmd, false, null);
    scheduleSave();
    return;
  }

  // No selection: toggle "typing mode" — button stays lit while you type.
  const btn = document.querySelector(`.fmt-btn[data-cmd="${cmd}"]`);
  if (!btn) return;
  const willActivate = !btn.classList.contains('active');
  if (willActivate !== fmtState[cmd]) {
    document.execCommand(cmd, false, null);
  }
  fmtState[cmd] = willActivate;
  btn.classList.toggle('active');
}

function resetFormatButtons() {
  typingColor = null;
  colorBar.style.background = '';
  Object.keys(fmtState).forEach(cmd => {
    if (fmtState[cmd]) {
      document.execCommand(cmd, false, null);
      fmtState[cmd] = false;
    }
  });
  document.querySelectorAll('.fmt-btn').forEach(btn => btn.classList.remove('active'));
}

document.querySelectorAll('.fmt-btn').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault()); // keep selection
  btn.addEventListener('click', () => applyFormat(btn.dataset.cmd));
});

// ── Text color ────────────────────────────────────────────────────────────────
// Selection: recolors the selected text. No selection: sets the color for the
// text typed next (the browser keeps it until the caret moves elsewhere).
const colorBtn    = document.getElementById('btn-color');
const colorPop    = document.getElementById('color-popover');
const colorBar    = document.getElementById('color-swatch-bar');
const colorCustom = document.getElementById('color-custom');
let colorSavedRange = null;   // selection to restore after the native picker steals focus

function closeColorPopover() {
  colorPop.classList.remove('open');
  colorBtn.classList.remove('open');
  colorPop.setAttribute('aria-hidden', 'true');
}

let typingColor = null;       // color for text typed next; null = no preference (browser default)

function execForeColor(color) {   // color: '#rrggbb', or '' for the default color
  const value = color || rgbToHex(getComputedStyle(editor).color);
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('foreColor', false, value);
  document.execCommand('styleWithCSS', false, false);
}

function applyTextColor(color) {   // color: '#rrggbb', or '' for the default color
  editor.focus();
  if (colorSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(colorSavedRange);
    colorSavedRange = null;
  }
  const sel = window.getSelection();
  // No selection: remember the color so it survives caret moves until changed.
  if (sel && sel.isCollapsed) typingColor = color;
  execForeColor(color);
  colorBar.style.background = color || '';
  scheduleSave();
}

// Typed text takes the remembered color even if the caret moved or the browser
// inherited a neighbour's color — same select-and-fix approach as the format fix.
editor.addEventListener('input', e => {
  if (typingColor === null || e.inputType !== 'insertText' || !e.data) return;
  const want = typingColor || rgbToHex(getComputedStyle(editor).color);
  if (rgbToHex(document.queryCommandValue('foreColor')) === want) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer, offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE || offset < e.data.length) return;

  const fix = document.createRange();
  fix.setStart(node, offset - e.data.length);
  fix.setEnd(node, offset);
  sel.removeAllRanges();
  sel.addRange(fix);
  execForeColor(typingColor);
  sel.collapseToEnd();
});

colorBtn.addEventListener('mousedown', e => e.preventDefault());   // keep selection
colorBtn.addEventListener('click', () => {
  const open = !colorPop.classList.contains('open');
  closeColorPopover();
  if (!open) return;
  const appRect = document.getElementById('app').getBoundingClientRect();
  const btnRect = colorBtn.getBoundingClientRect();
  colorPop.classList.add('open');
  colorPop.setAttribute('aria-hidden', 'false');
  colorBtn.classList.add('open');
  const left = btnRect.left - appRect.left + btnRect.width / 2 - colorPop.offsetWidth / 2;
  colorPop.style.left = Math.max(6, Math.min(left, appRect.width - colorPop.offsetWidth - 6)) + 'px';
});

colorPop.querySelectorAll('.color-sw').forEach(sw => {
  sw.addEventListener('mousedown', e => e.preventDefault());
  sw.addEventListener('click', () => { applyTextColor(sw.dataset.color); closeColorPopover(); });
});

// The native picker takes focus, so remember the selection first.
colorCustom.addEventListener('mousedown', () => {
  const sel = window.getSelection();
  colorSavedRange = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
});
colorCustom.addEventListener('change', () => { applyTextColor(colorCustom.value); closeColorPopover(); });

document.addEventListener('mousedown', e => {
  if (!colorPop.contains(e.target) && !colorBtn.contains(e.target)) closeColorPopover();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeColorPopover(); });

// After a character is typed, fix its formatting if the browser silently
// inherited bold/italic/etc. from adjacent styled text.  We select the
// just-inserted character(s) and toggle each mismatched format — execCommand
// on a real selection is reliable, unlike toggling on a collapsed cursor.
editor.addEventListener('input', e => {
  if (e.inputType !== 'insertText' || !e.data) return;

  const cmdsToFix = [];
  for (const cmd of Object.keys(fmtState)) {
    if (document.queryCommandState(cmd) !== fmtState[cmd]) {
      cmdsToFix.push(cmd);
    }
  }
  if (cmdsToFix.length === 0) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE || offset < e.data.length) return;

  const fixRange = document.createRange();
  fixRange.setStart(node, offset - e.data.length);
  fixRange.setEnd(node, offset);
  sel.removeAllRanges();
  sel.addRange(fixRange);

  for (const cmd of cmdsToFix) {
    document.execCommand(cmd, false, null);
  }

  sel.collapseToEnd();
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
editor.addEventListener('keydown', e => {
  // Code block trigger: /language + Enter or Space
  if (e.key === 'Enter' || e.key === ' ') {
    if (tryInsertCodeBlock(e)) return;
  }

  // Arrow key navigation into adjacent code blocks (synchronous pre-check).
  // We inspect where the cursor is BEFORE the browser moves it. If it is on
  // the last visual line above a code block (ArrowDown) or the first visual
  // line below one (ArrowUp), we intercept and focus the textarea directly.
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const goingDown = e.key === 'ArrowDown';
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      let lineEl = range.startContainer;
      while (lineEl && lineEl.parentNode !== editor) lineEl = lineEl.parentNode;

      if (lineEl && lineEl !== editor) {
        if (goingDown) {
          let sib = lineEl.nextSibling;
          while (sib && sib.nodeName === 'BR') sib = sib.nextSibling;
          if (sib && sib.nodeType === Node.ELEMENT_NODE && sib.classList.contains('code-block') &&
              isOnLastVisualLine(range, lineEl)) {
            e.preventDefault();
            const ta = sib.querySelector('.code-textarea');
            if (ta) { ta.focus(); ta.setSelectionRange(0, 0); }
          }
        } else {
          let sib = lineEl.previousSibling;
          while (sib && sib.nodeName === 'BR') sib = sib.previousSibling;
          if (sib && sib.nodeType === Node.ELEMENT_NODE && sib.classList.contains('code-block') &&
              isOnFirstVisualLine(range, lineEl)) {
            e.preventDefault();
            const ta = sib.querySelector('.code-textarea');
            if (ta) { const len = ta.value.length; ta.focus(); ta.setSelectionRange(len, len); }
          }
        }
      }

      // Prevent browser wrap-around: at the very top/bottom of the editor the
      // browser moves the cursor to the opposite end of the content. Block it.
      // Skip when rRect.height === 0 (cursor in a <br>/empty line) — those
      // positions always return true from isOnFirst/LastVisualLine and would
      // freeze both arrow keys.
      const rRect = range.getBoundingClientRect();
      if (rRect.height > 0) {
        const edRect = editor.getBoundingClientRect();
        if (!goingDown && rRect.top    <= edRect.top    + 2) e.preventDefault();
        if (goingDown  && rRect.bottom >= edRect.bottom - 2) e.preventDefault();
      }
    }
  }

  // Guard: prevent Backspace / Delete from swallowing an adjacent code block.
  // beforeinput's getTargetRanges() only returns the merge-boundary, not the
  // block itself, so intersectsNode() always misses it. keydown is reliable.
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.getRangeAt(0).collapsed) {
      const range     = sel.getRangeAt(0);
      const container = range.startContainer;
      const offset    = range.startOffset;
      let adjacent    = null;

      // Returns true for nodes that are "visually empty" — BRs, whitespace text,
      // or elements whose every descendant is one of those (e.g. <div><br><br></div>).
      function isVisuallyEmpty(n) {
        if (!n) return false;
        if (n.nodeName === 'BR') return true;
        if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.trim() === '';
        if (n.nodeType === Node.ELEMENT_NODE)
          return n.childNodes.length > 0 && [...n.childNodes].every(isVisuallyEmpty);
        return false;
      }

      if (e.key === 'Backspace') {
        if (container === editor) {
          adjacent = offset > 0 ? editor.childNodes[offset - 1] : null;
        } else {
          let node = container;
          while (node && node !== editor && node.parentNode !== editor) node = node.parentNode;
          if (node && node !== editor) {
            const isLineStart = offset === 0;
            const isEmptyLine = node.nodeType === Node.ELEMENT_NODE && isVisuallyEmpty(node);
            if (isLineStart || isEmptyLine) adjacent = node.previousSibling;
          }
        }
        while (adjacent && isVisuallyEmpty(adjacent)) adjacent = adjacent.previousSibling;
      } else {
        const atEnd = container.nodeType === Node.TEXT_NODE
          ? offset === container.nodeValue.length
          : offset === container.childNodes.length;
        if (container === editor) {
          adjacent = editor.childNodes[offset] || null;
        } else if (atEnd) {
          let node = container;
          while (node && node !== editor && node.parentNode !== editor) node = node.parentNode;
          if (node && node !== editor) adjacent = node.nextSibling;
        }
        while (adjacent && isVisuallyEmpty(adjacent)) adjacent = adjacent.nextSibling;
      }

      if (adjacent && adjacent.nodeType === Node.ELEMENT_NODE && adjacent.classList.contains('code-block')) {
        e.preventDefault();
      }
    }
  }

  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 'z': {
        // Restore the most recently X-deleted code block before falling through to browser undo
        if (deletedBlocks.length > 0) {
          e.preventDefault();
          const { el, afterEl } = deletedBlocks.pop();
          if (afterEl && afterEl.parentNode === editor) editor.insertBefore(el, afterEl);
          else editor.appendChild(el);
          setupCodeBlock(el);
          scheduleSave();
        }
        break;
      }
      case 'b': e.preventDefault(); applyFormat('bold');      break;
      case 'i': e.preventDefault(); applyFormat('italic');    break;
      case 'u': e.preventDefault(); applyFormat('underline'); break;
      case 'n': e.preventDefault(); btnNew.click();           break;
      case 'f': e.preventDefault(); openSearch();             break;
    }
  }
  if (e.key === 'Escape' && searchOpen) closeSearch();
});

// Also catch Ctrl+F from anywhere in the window (e.g. when sidebar is focused)
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
  }
  // Ctrl+Tab / Ctrl+Shift+Tab to cycle through open tabs
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    if (openTabs.length < 2) return;
    const curIdx = openTabs.findIndex(t => t.filename === currentFilename);
    const dir = e.shiftKey ? -1 : 1;
    const nextIdx = (curIdx + dir + openTabs.length) % openTabs.length;
    const nextNote = allNotes.find(n => n.filename === openTabs[nextIdx].filename);
    if (nextNote) switchToNote(nextNote);
  }
});


// ── Re-wire code blocks restored by Ctrl+Z ────────────────────────────────────
// Direct DOM removal bypasses the browser's undo stack; we use execCommand
// instead. When Ctrl+Z restores the HTML the event listeners are gone, so this
// observer calls setupCodeBlock again on any unwired (.code-block) node.
const codeBlockObserver = new MutationObserver(() => {
  editor.querySelectorAll('.code-block:not([data-wired])').forEach(block => {
    setupCodeBlock(block);
  });
});
codeBlockObserver.observe(editor, { childList: true });

// ── Lists & indentation ───────────────────────────────────────────────────────
// Lists are plain text lines inside the editor:  "• item", "1. item", "☐ item" / "☑ item",
// each optionally indented by multiples of 8 spaces. On disk they are stored as markdown
// ("- item", "1. item", "- [ ] item" / "- [x] item") — see listsToMarkdown / inlineToHtml.
// Line-level edits use the Selection API (paragraph boundaries) so they work regardless of
// whether lines are <br>-separated or <div>-wrapped.
const INDENT  = '        ';                       // Tab = 8 spaces
const LIST_RE = /^( *)(• |☐ |☑ |\d+\. )/;

const caretSel = () => window.getSelection();

/** Number of characters between the start of the caret's line and the caret. */
function lineColumn() {
  const sel = caretSel();
  sel.modify('extend', 'backward', 'paragraphboundary');
  const n = sel.toString().length;
  sel.collapseToEnd();                            // back to the caret
  return n;
}

/** Text of the caret's line, split at the caret. */
function lineParts() {
  const sel = caretSel();
  sel.modify('extend', 'backward', 'paragraphboundary');
  const before = sel.toString();
  sel.collapseToEnd();
  sel.modify('extend', 'forward', 'paragraphboundary');
  const after = sel.toString().replace(/\n+$/, '');
  sel.collapseToStart();
  return { before, after };
}

function moveCaret(n, extend = false) {
  const sel = caretSel();
  const dir = n < 0 ? 'backward' : 'forward';
  for (let i = 0; i < Math.abs(n); i++) sel.modify(extend ? 'extend' : 'move', dir, 'character');
}

function setLineColumn(target) { moveCaret(target - lineColumn()); }

/** Replace `len` chars starting `from` chars into the caret's line with `text`. Caret ends after it. */
function replaceInLine(from, len, text) {
  moveCaret(-lineColumn());
  moveCaret(from);
  if (len) moveCaret(len, true);
  if (text) document.execCommand('insertText', false, text);
  else if (len) document.execCommand('delete');
}

function inEditorCaret() {
  const sel = caretSel();
  return sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode);
}

function indentLine() {
  const { before, after } = lineParts();
  if (LIST_RE.test(before + after)) {
    replaceInLine(0, 0, INDENT);
    setLineColumn(before.length + INDENT.length);
  } else {
    document.execCommand('insertText', false, INDENT);
  }
}

function outdentLine() {
  const { before, after } = lineParts();
  const remove = Math.min(INDENT.length, (before + after).match(/^ */)[0].length);
  if (!remove) return;
  replaceInLine(0, remove, '');
  setLineColumn(Math.max(0, before.length - remove));
}

const LIST_KINDS = {
  bullet: { marker: '• ',  is: m => m === '• ' },
  number: { marker: '1. ', is: m => /^\d+\. $/.test(m) },
  check:  { marker: '☐ ',  is: m => m === '☐ ' || m === '☑ ' },
};

/** Add / switch / remove a list marker on the caret's line. */
function toggleListMarker(kind) {
  if (!inEditorCaret()) return;
  const sel = caretSel();
  if (!sel.isCollapsed) sel.collapseToStart();
  const { before, after } = lineParts();
  const text   = before + after;
  const indent = text.match(/^ */)[0].length;
  const cur    = (text.match(LIST_RE) || [])[2] || '';
  const next   = cur && LIST_KINDS[kind].is(cur) ? '' : LIST_KINDS[kind].marker;
  replaceInLine(indent, cur.length, next);
  const col = before.length;
  setLineColumn(col >= indent + cur.length ? col + next.length - cur.length : indent + next.length);
  scheduleSave();
}

/** True if the line above the caret's line is a list item. */
function previousLineIsList() {
  const sel = caretSel();
  const col = lineColumn();
  sel.modify('extend', 'backward', 'paragraphboundary');   // to start of this line
  sel.modify('extend', 'backward', 'character');           // across the line break
  sel.modify('extend', 'backward', 'paragraphboundary');   // to start of the line above
  const t = sel.toString();
  sel.collapseToEnd();                                     // back to the caret
  return LIST_RE.test(t.slice(0, Math.max(0, t.length - col)).replace(/\n+$/, ''));
}

function handleListKeydown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.target.closest && e.target.closest('.code-block')) return;

  // Ctrl+Shift+8 bullets, +7 numbered, +9 checklist (same as Google Docs)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    const kind = { Digit8: 'bullet', Digit7: 'number', Digit9: 'check' }[e.code];
    if (kind) { e.preventDefault(); toggleListMarker(kind); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !inEditorCaret()) return;
  const sel = caretSel();

  if (e.key === 'Tab') {
    e.preventDefault();
    if (!sel.isCollapsed) return;                 // never overwrite a selection with spaces
    if (e.shiftKey) outdentLine(); else indentLine();
    scheduleSave();
    return;
  }
  if (!sel.isCollapsed) return;

  const { before, after } = lineParts();

  // "-␠" → bullet,  "[]␠" / "[ ]␠" / "[x]␠" (optionally after a bullet) → checkbox
  if (e.key === ' ' && after === '') {
    let m = before.match(/^( *)[-*+]$/);
    if (m) {
      e.preventDefault();
      replaceInLine(m[1].length, 1, '• ');
      return;
    }
    m = before.match(/^( *)(?:• )?\[( |x|X)?\]$/);
    if (m) {
      e.preventDefault();
      replaceInLine(m[1].length, before.length - m[1].length, (m[2] || '').toLowerCase() === 'x' ? '☑ ' : '☐ ');
      return;
    }
    return;
  }

  // "1." + Enter (before typing the space) → "1. " then "2. "
  const numStart = e.key === 'Enter' && !e.shiftKey && after === '' && before.match(/^( *)(\d+)\.$/);
  if (numStart) {
    e.preventDefault();
    replaceInLine(numStart[1].length, numStart[2].length + 1, numStart[2] + '. ');
    document.execCommand('insertParagraph');
    document.execCommand('insertText', false, numStart[1] + (parseInt(numStart[2], 10) + 1) + '. ');
    scheduleSave();
    return;
  }

  // Backspace inside a run of spaces removes a whole tab: back to the previous 8-space
  // stop in the indentation, or one full tab (8 spaces) elsewhere on the line.
  if (e.key === 'Backspace') {
    const run = before.match(/ *$/)[0].length;
    const n = /^ +$/.test(before) ? (run % INDENT.length || INDENT.length)
            : (run >= INDENT.length ? INDENT.length : 0);
    if (n > 1) {
      e.preventDefault();
      moveCaret(-n, true);
      document.execCommand('delete');
      scheduleSave();
      return;
    }
  }

  const lm = (before + after).match(LIST_RE);
  if (!lm) return;
  const markerEnd = lm[0].length;

  // Enter: continue the list; Enter on an empty item leaves the list (or outdents)
  if (e.key === 'Enter' && !e.shiftKey && before.length >= markerEnd) {
    e.preventDefault();
    const emptyItem = !(before + after).slice(markerEnd).trim();
    // An empty item leaves the list — except the first "1. " of a numbered list, where Enter should give "2. ".
    if (emptyItem && !(/^\d+\. $/.test(lm[2]) && !previousLineIsList())) {
      if (lm[1].length) { outdentLine(); }
      else { replaceInLine(0, markerEnd, ''); }
      scheduleSave();
      return;
    }
    const marker = lm[2];
    const next = /^\d+\. $/.test(marker) ? `${parseInt(marker, 10) + 1}. `
               : marker === '• ' ? '• ' : '☐ ';
    document.execCommand('insertParagraph');
    document.execCommand('insertText', false, lm[1] + next);
    scheduleSave();
    return;
  }

  // Backspace right after a marker removes the marker (or outdents a nested item)
  if (e.key === 'Backspace' && before.length === markerEnd) {
    e.preventDefault();
    if (lm[1].length) { outdentLine(); }
    else { replaceInLine(0, markerEnd, ''); }
    scheduleSave();
  }
}
editor.addEventListener('keydown', handleListKeydown);

// Toolbar buttons: bullet / numbered / checklist on the current line
document.querySelectorAll('.list-btn').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());   // keep the caret in the editor
  btn.addEventListener('click', () => {
    editor.focus();
    if (!inEditorCaret()) {                                     // no caret yet: start at the end of the note
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      caretSel().removeAllRanges();
      caretSel().addRange(r);
    }
    toggleListMarker(btn.dataset.list);
  });
});

// Click a ☐ / ☑ to toggle it
editor.addEventListener('click', e => {
  if (!inEditorCaret()) return;
  const sel = caretSel();
  if (!sel.isCollapsed || e.target.closest('.code-block')) return;
  const { before, after } = lineParts();
  const range = sel.getRangeAt(0).cloneRange();
  const node = range.startContainer, offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) return;

  let glyphStart = -1;                             // offset of the checkbox char inside `node`
  if (/^ *$/.test(before) && /^[☐☑]/.test(after) && offset < node.nodeValue.length) glyphStart = offset;
  else if (/^ *[☐☑]$/.test(before) && offset > 0) glyphStart = offset - 1;
  if (glyphStart < 0 || !/[☐☑]/.test(node.nodeValue[glyphStart] || '')) return;

  const g = document.createRange();
  g.setStart(node, glyphStart);
  g.setEnd(node, glyphStart + 1);
  const r = g.getBoundingClientRect();
  if (e.clientX < r.left - 2 || e.clientX > r.right + 2 || e.clientY < r.top - 2 || e.clientY > r.bottom + 2) return;

  const col = before.length;
  const indent = (before + after).match(/^ */)[0].length;
  replaceInLine(indent, 1, node.nodeValue[glyphStart] === '☐' ? '☑' : '☐');
  setLineColumn(col);
  scheduleSave();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  allNotes = await window.notesAPI.loadAll();  // newest first

  if (allNotes.length > 0) {
    currentFilename  = allNotes[0].filename;
    editor.innerHTML = textToHtml(allNotes[0].content);
    initCodeBlocks();
    ensureTrailingLine();
    snapToLineGrid();
  } else {
    currentFilename = makeFilename();
  }

  ensureTab(currentFilename);
  renderTabs();

  // Always-on-top starts OFF (floating off); reflect whatever the main process reports
  setAotLabel(await window.notesAPI.isAlwaysOnTop());

  editor.focus();
  // Move caret to end
  const sel = window.getSelection();
  const rng = document.createRange();
  rng.selectNodeContents(editor);
  rng.collapse(false);
  sel.removeAllRanges();
  sel.addRange(rng);
}

init();

// ── Right-click context menu ──────────────────────────────────────────────────
(function () {
  const menu          = document.getElementById('context-menu');
  const ctxCopy       = document.getElementById('ctx-copy');
  const ctxCut        = document.getElementById('ctx-cut');
  const ctxPaste      = document.getElementById('ctx-paste');
  const ctxSpellcheck = document.getElementById('ctx-spellcheck');
  const ctxHlRow      = document.getElementById('ctx-highlight-row');

  function closeMenu() {
    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
  }

  function openMenu(x, y) {
    menu.classList.add('open');
    menu.setAttribute('aria-hidden', 'false');

    // Clamp so menu never overflows the window
    const mw = menu.offsetWidth  || 160;
    const mh = menu.offsetHeight || 160;
    const px = Math.min(x, window.innerWidth  - mw - 6);
    const py = Math.min(y, window.innerHeight - mh - 6);
    menu.style.left = px + 'px';
    menu.style.top  = py + 'px';

    // Show whether the selected text already has each format applied;
    // disable the format row entirely when nothing is selected.
    const hasSel = window.getSelection().toString().length > 0;
    document.querySelectorAll('.ctx-fmt-btn').forEach(btn => {
      btn.disabled = !hasSel;
      btn.classList.toggle('active', hasSel && document.queryCommandState(btn.dataset.cmd));
    });

    // Disable highlight buttons when nothing is selected
    document.querySelectorAll('.ctx-hl-btn').forEach(btn => {
      btn.disabled = !hasSel;
    });

    // Disable Copy/Cut when nothing is selected
    ctxCopy.disabled = !hasSel;
    ctxCut.disabled  = !hasSel;

    // Spellcheck toggle label
    const spellOn = editor.getAttribute('spellcheck') === 'true';
    ctxSpellcheck.textContent = (spellOn ? '✓ ' : '   ') + 'Spell Check';
  }

  // Show on right-click inside the editor
  editor.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  // Format buttons — mousedown keeps the selection alive.
  // These operate independently of the toolbar: execCommand directly,
  // state read from queryCommandState, no toolbar buttons touched.
  document.querySelectorAll('.ctx-fmt-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      editor.focus();
      document.execCommand(btn.dataset.cmd, false, null);
      btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd));
      scheduleSave();
    });
  });

  // Text color row — applies to the selection, or sets the color for typing.
  // List row — toggles a bullet / numbered / checkbox marker on the current line.
  document.querySelectorAll('.ctx-list-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep caret
    btn.addEventListener('click', () => { editor.focus(); toggleListMarker(btn.dataset.list); closeMenu(); });
  });

  document.querySelectorAll('.ctx-col-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep selection
    btn.addEventListener('click', () => { applyTextColor(btn.dataset.color); closeMenu(); });
  });

  ctxCopy.addEventListener('mousedown', e => e.preventDefault());
  ctxCopy.addEventListener('click', () => {
    document.execCommand('copy');
    closeMenu();
  });

  ctxCut.addEventListener('mousedown', e => e.preventDefault());
  ctxCut.addEventListener('click', () => {
    document.execCommand('cut');
    closeMenu();
    scheduleSave();
  });

  ctxPaste.addEventListener('click', async () => {
    closeMenu();
    editor.focus();
    try {
      const text = await navigator.clipboard.readText();
      document.execCommand('insertText', false, text);
      scheduleSave();
    } catch {
      document.execCommand('paste');
    }
  });

  ctxSpellcheck.addEventListener('click', () => {
    const isOn = editor.getAttribute('spellcheck') === 'true';
    editor.setAttribute('spellcheck', isOn ? 'false' : 'true');
    // Force re-render of spellcheck by briefly blurring
    editor.blur();
    editor.focus();
    closeMenu();
  });

  // ── Highlight buttons ──────────────────────────────────────────────────────
  document.querySelectorAll('.ctx-hl-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep selection
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { closeMenu(); return; }

      const range = sel.getRangeAt(0);

      if (!color) {
        // Remove highlight: unwrap any .user-highlight spans that overlap the selection.
        // 1) Walk up from the selection to find an ancestor highlight span
        let ancestor = range.commonAncestorContainer;
        if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
        const ancestorHL = ancestor.closest ? ancestor.closest('span.user-highlight') : null;

        // 2) Also find any descendant highlight spans inside the selection
        const searchRoot = ancestorHL || ancestor;
        const descendants = searchRoot.querySelectorAll
          ? Array.from(searchRoot.querySelectorAll('span.user-highlight'))
          : [];

        // 3) Collect all unique spans to unwrap
        const toUnwrap = new Set(descendants);
        if (ancestorHL) toUnwrap.add(ancestorHL);

        toUnwrap.forEach(span => {
          span.replaceWith(...span.childNodes);
        });
        editor.normalize();
      } else {
        // Apply highlight: wrap selection in a colored span
        const contents = range.extractContents();
        const span = document.createElement('span');
        span.className = 'user-highlight';
        span.style.background = color;
        span.appendChild(contents);
        range.insertNode(span);
        // Re-select the highlighted text
        sel.removeAllRanges();
        const newRange = document.createRange();
        newRange.selectNodeContents(span);
        sel.addRange(newRange);
      }

      scheduleSave();
      closeMenu();
    });
  });

  // Close on any outside click, Escape, or scroll
  document.addEventListener('mousedown', e => {
    if (!menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });
  document.addEventListener('scroll', closeMenu, true);
})();
