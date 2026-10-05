// Starter content written into new vaults. Existing files are never overwritten.

export const SEED_FILES = {
  'Templates/Meeting Notes.md': `---
template-name: "{{date}} {{prompt:Meeting title}}"
template-folder: Meetings
type: meeting
date: {{date}}
tags: [meeting]
---
# {{prompt:Meeting title}}

- **Date:** {{date:dddd, MMMM D, YYYY}} at {{time:h:mm A}}
- **Attendees:** {{prompt:Attendees}}
- **Project:** [[{{prompt:Project|General}}]]

## Agenda
- {{cursor}}

## Notes
-

## Decisions
-

## Action items
- [ ] Owner — task — due date

## Follow-up
- Next meeting:
`,

  'Templates/Daily Note.md': `---
date: {{date}}
tags: [daily]
---
# {{date:dddd, MMMM D, YYYY}}

← [[{{yesterday}}]] | [[{{tomorrow}}]] →

## Focus for today
- [ ] {{cursor}}

## Meetings
-

## Notes
-

## End of day
- What went well:
- What to carry over:
`,

  'Templates/1-on-1.md': `---
template-name: "{{date}} 1-on-1 with {{prompt:Person}}"
template-folder: Meetings/1-on-1s
type: one-on-one
date: {{date}}
tags: [meeting, 1on1]
---
# 1-on-1 with [[{{prompt:Person}}]]

- **Date:** {{date:dddd, MMMM D, YYYY}}

## Their topics
- {{cursor}}

## My topics
-

## Feedback
-

## Action items
- [ ]
`,

  'Templates/Project.md': `---
template-folder: Projects
type: project
status: {{prompt:Status|active}}
created: {{date}}
tags: [project]
---
# {{title}}

## Goal
{{cursor}}

## Key links
-

## Tasks
- [ ]

## Meeting log
<!-- Meeting notes that link to [[{{title}}]] appear in the Backlinks panel. -->
`,

  'Welcome.md': `# Welcome to your vault

Everything here is a plain Markdown file in this folder on your computer. You can
open, edit, back up, or sync the folder with any tool — this app just gives it a
nicer interface.

## The basics
- **New note:** Alt+N, or the ＋ button in the sidebar.
- **New note from a template:** Alt+T — try *Meeting Notes*.
- **Today's daily note:** Alt+D.
- **Quick switcher:** Ctrl/Cmd+O. **Search:** Ctrl/Cmd+Shift+F.
- **Toggle edit / split / preview:** Ctrl/Cmd+E.

## Linking
Type \`[[\` to link to another note, like [[Getting started with templates]].
Links to notes that don't exist yet are shown dimmed; click one to create it.
Every note shows its **backlinks** — the notes that link to it.

Add #tags anywhere and browse them from the Tags panel.

## Templates
Templates live in the \`Templates\` folder. Edit them like any other note, or add
your own. See [[Getting started with templates]].
`,

  'Getting started with templates.md': `# Getting started with templates

A template is a normal note in the \`Templates\` folder. When you create a note
from it, these placeholders are filled in:

| Placeholder | Becomes |
| --- | --- |
| \`{{title}}\` | the new note's title |
| \`{{date}}\` / \`{{time}}\` | today (2026-10-05) / now (14:30) |
| \`{{date:dddd, MMMM D}}\` | a custom format, e.g. Monday, October 5 |
| \`{{date+1d}}\`, \`{{date-1w:YYYY-MM-DD}}\` | dates relative to today (d, w, m, y) |
| \`{{yesterday}}\` / \`{{tomorrow}}\` | the neighbouring days |
| \`{{prompt:Attendees}}\` | asks you for a value when creating the note |
| \`{{prompt:Status\\|active}}\` | ...with a default value |
| \`{{cursor}}\` | where your cursor starts |

Format tokens: \`YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a\`; wrap
literal text in square brackets, e.g. \`{{date:[Week of] MMM D}}\`.

## Naming and filing notes automatically
Add these to the template's frontmatter (they are removed from the new note):

\`\`\`yaml
---
template-name: "{{date}} {{prompt:Meeting title}}"
template-folder: Meetings/{{date:YYYY}}
---
\`\`\`

With \`template-name\`, you don't have to type a title — it is built from your answers.
`,
};
