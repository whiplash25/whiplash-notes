# Otter

An ultra-minimalist, always-on-top note-taking app for Windows 11. Built for video note-taking — it floats above every other window so you never lose your place.

---

## Download

Grab the latest `.exe` from the [Releases](../../releases) page. No installation needed — just double-click and it opens.

> If Windows shows a SmartScreen warning, click **More info → Run anyway**. This is normal for unsigned indie apps.

---

## Features

- **Always on Top** — floats above every other window, including video players. Click the status text in the bottom-right corner, or press `Ctrl+Alt+T` from anywhere (even when another app is focused), to toggle it on/off.
- **Frameless dark UI** — deep charcoal background, rounded corners, no distracting title bar.
- **Rich text formatting** — Bold, Italic, Underline, and Strikethrough via toolbar buttons or `Ctrl+B / I / U`.
- **Lists & indentation** — type `- ` for a bullet list, `1. ` for a numbered list, or `[] ` for a checklist (click a box to tick it). `Enter` continues the list, `Enter` on an empty item ends it, `Tab` / `Shift+Tab` indent / outdent by 8 spaces. Shortcuts: `Ctrl+Shift+8` bullets, `Ctrl+Shift+7` numbered, `Ctrl+Shift+9` checklist (also in the right-click menu). Saved as plain Markdown (`- item`, `- [ ] task`).
- **Adjustable font size** — change it on the fly from the toolbar.
- **Notes sidebar** — click the ≡ button to see all your saved notes and switch between them.
- **Auto-save** — every keystroke is saved automatically after a short pause. No manual saving ever.
- **Plain `.txt` files** — notes are saved to `Documents\WhiplashNotes\` as readable text files you can open in Notepad, VS Code, or any editor.
- **100% offline** — zero cloud, zero analytics, zero external connections.

---

## Running from Source

Requires [Node.js](https://nodejs.org) (LTS).

```bash
git clone https://github.com/SwopnilSunder/whiplash-notes.git
cd whiplash-notes
npm install
npm start
```

To build the portable `.exe` yourself:

```bash
npm run dist
```

The output will be in the `dist/` folder.

---

## Where are my notes saved?

```
C:\Users\<you>\Documents\WhiplashNotes\
```

Each note is a plain `.txt` file named by date and time (e.g. `note_20260506_143022.txt`). You can open, edit, back up, or sync them with anything you like.

---

## Tech Stack

- [Electron](https://www.electronjs.org/) — cross-platform desktop shell
- Vanilla JavaScript, HTML, CSS — no frameworks
- Node.js `fs` module — local file storage

---

## License

MIT — do whatever you want with it.
