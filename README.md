# Notes

A local-first notes app in the spirit of Obsidian. Your notes are plain Markdown
files in a folder on your computer (a *vault*). The app runs on your machine,
needs no account, and works offline. Nothing leaves your computer.

Because notes are ordinary `.md` files, you can also open the same folder in
Obsidian, VS Code or any text editor, and sync or back it up however you like
(git, Syncthing, iCloud or Dropbox folders, and so on).

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm start                       # uses ~/Notes as the vault
npm start -- ~/Documents/Work   # or any folder
npm start -- ~/Notes --open --port 5000
```

Then open http://localhost:4321. A new vault comes with a welcome note and
starter templates. To use it as the `notes` command anywhere, run `npm link`.

## Features

- **Markdown editor** with Edit, Split and Preview modes (Ctrl/Cmd+E). Saves automatically.
- **Wiki links**: `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, with autocomplete
  as you type `[[`. Clicking a link to a missing note creates it.
- **Backlinks and unlinked mentions** for every note, plus a heading outline.
- **Embeds**: `![[Other note]]`, `![[Note#Section]]`, and images (`![[diagram.png]]`).
  Pasting or dropping an image saves it to `attachments/`.
- **Tags**: `#tag` inline or `tags: [a, b]` in frontmatter. Browse them in the Tags panel.
- **Search** across all notes (`#tag` and multiple words work).
- **Clickable task checkboxes** in preview. They update the Markdown source.
- **Daily notes** (Alt+D), built from your daily template.
- **Renaming updates links** across the vault. Drag notes between folders.
- **Safe deletes**: deleted items go to the vault's `.trash/` folder.
- **Live reload**: edits made in another app show up immediately. If both sides
  changed the note, you choose which version to keep.
- Light and dark themes.

## Templates

Templates are normal notes in the `Templates/` folder (configurable in Settings).
Create a note from one with **Alt+T** or the ▤ button. Starter templates:
*Meeting Notes*, *1-on-1*, *Daily Note* and *Project*.

| Placeholder | Becomes |
| --- | --- |
| `{{title}}` | the new note's title |
| `{{date}}`, `{{time}}` | `2026-10-05`, `14:30` |
| `{{date:dddd, MMMM D}}` | custom format, e.g. `Monday, October 5` |
| `{{date+1d}}`, `{{date-1w:YYYY-MM-DD}}` | relative dates (`d`, `w`, `m`, `y`) |
| `{{yesterday}}`, `{{tomorrow}}` | neighbouring days, handy for daily-note links |
| `{{prompt:Attendees}}` | asks for a value when you create the note |
| `{{prompt:Status\|active}}` | asks, with a default |
| `{{cursor}}` | where the cursor starts |

Format tokens: `YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a`. Put
literal text in square brackets: `{{date:[Week of] MMM D}}`.

Templates can name and file new notes automatically. These frontmatter keys are
removed from the new note:

```markdown
---
template-name: "{{date}} {{prompt:Meeting title}}"
template-folder: Meetings/{{date:YYYY}}
type: meeting
---
# {{prompt:Meeting title}}

- **Attendees:** {{prompt:Attendees}}

## Agenda
- {{cursor}}
```

When this template is used, the app asks for *Meeting title* and *Attendees*, then
creates `Meetings/2026/2026-10-05 Design review.md`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+O | Quick switcher: find or create a note |
| Ctrl/Cmd+Shift+F | Search |
| Alt+N / Alt+T / Alt+D | New note / new from template / today's daily note |
| Ctrl/Cmd+E | Cycle Edit, Preview and Split |
| Ctrl/Cmd+B, I, K | Bold, italic, wrap in `[[link]]` |
| Tab / Shift+Tab | Indent / outdent list items |
| Enter in a list | Continue the list (and checkboxes) |

## Settings

Settings are stored in `<vault>/.noteapp.json`: templates folder, daily-note folder,
template and name format, the default folder for new notes, and the attachments folder.

## How it works

```
server/
  cli.js        command-line entry point
  app.js        HTTP server: JSON API, static files, live-update stream
  vault.js      reads and writes the vault: index, search, backlinks, rename, trash
  templates.js  template engine (placeholders, dates, prompts)
  markdown.js   link and tag parsing, shared with the browser
  seed.js       starter templates for new vaults
public/         the UI (plain ES modules, no build step)
test/           node:test suites
```

The server listens only on `127.0.0.1`. It also rejects requests whose `Host`
header isn't localhost (blocking DNS rebinding), requests marked
`Sec-Fetch-Site: cross-site`, and API calls without a custom header. Together these
stop websites you visit from reading or changing your notes. File access is
confined to the vault, including through symlinks.

```bash
npm test
```

## Ideas for next steps

- Package as a desktop app (Tauri or Electron) so it runs without a terminal.
- Graph view of links between notes.
- Live-preview editing (rendering Markdown inline as you type), e.g. with CodeMirror 6.
- Tabs and split panes for multiple notes.
- Queries over frontmatter, e.g. "all meetings for project X".
