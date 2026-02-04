# Designer Memory

## Theme System

### Files

- `src/theme/index.ts` - Colors, banner, quotes, status emoji
- `src/theme/ui.ts` - UI components, formatters, icons

### Colors (colorette-based)

```typescript
import { colors, success, error, warning, info, muted, highlight } from '@src/theme/index.ts';

success('Done!'); // Green - positive outcomes
error('Failed!'); // Red - errors
warning('Caution!'); // Yellow - warnings, in-progress
info('Status:'); // Cyan - headers, labels
muted('(optional)'); // Gray - secondary info
highlight('important'); // Yellow - emphasis
```

### Icons (ASCII for professional look)

```typescript
import { icons } from '@src/theme/ui.ts';

icons.sprint; // '>'
icons.ticket; // '#'
icons.task; // '*'
icons.project; // '@'
icons.success; // '+'
icons.error; // 'x'
icons.warning; // '!'
icons.bullet; // '-'
```

### Status Emoji

```typescript
import { getStatusEmoji, statusEmoji } from '@src/theme/index.ts';

statusEmoji.todo; // '📝'
statusEmoji.in_progress; // '🏃'
statusEmoji.done; // '✅'
statusEmoji.draft; // '📋'
statusEmoji.active; // '🎯'
statusEmoji.closed; // '🎉'
```

## Output Patterns

### Success with Fields

```typescript
showSuccess('Sprint created!', [
  ['ID', sprint.id],
  ['Name', sprint.name],
]);
```

### Error Messages

```typescript
showError('Project not found');
showNextStep('ralphctl project add', 'create it first');
```

### Empty State

```typescript
showEmpty('tasks', 'Add one with: ralphctl task add');
// Output: "  o  No tasks yet."
//         "     ? Add one with: ralphctl task add"
```

### Field Formatting

```typescript
field('Status', formatTaskStatus(task.status)); // Aligned label: value
fields([
  ['ID', id],
  ['Name', name],
]); // Multiple aligned fields
fieldMultiline('Description', longText); // Multi-line with indent
```

### Logging Utilities

```typescript
log.info('Processing...'); // "  i  Processing..."
log.success('Done!'); // "  +  Done!"
log.warn('Careful'); // "  !  Careful"
log.error('Failed'); // "  x  Failed"
log.item('List item'); // "    -  List item"
```

## Command Output Modes

### Brief Mode (-b, --brief)

One line per item, compact format:

```
- 1. **[todo]** abc123: Task name (path) [ticket-id]
```

### Full Mode (default)

Markdown format for LLM readability:

```markdown
## 1. [todo] Task name (Ticket: ticket-id)

**ID:** abc123
**Project:** /path/to/project

### Description

...

### Steps

1. Step one
2. Step two
```

## Interactive Elements

### Spinner

```typescript
const spinner = createSpinner('Loading...');
spinner.start();
// ... async work
spinner.succeed('Done!');
```

### Sections

```typescript
printHeader('Sprint Details', emoji.donut);
printSeparator();
printBox(['Line 1', 'Line 2']);
```

## Ralph Wiggum Theme

- Banner in `theme/index.ts` with ASCII art
- Random quotes via `getRandomQuote()`
- Donut emoji (`🍩`) used in banner, spinners, prompts
- Themed messages in `messages` object for actions

## UX Conventions

| Pattern        | Implementation              |
| -------------- | --------------------------- |
| Empty state    | `showEmpty(what, hint)`     |
| Success        | `showSuccess(msg, fields?)` |
| Error          | `showError(msg)`            |
| Next action    | `showNextStep(cmd, desc?)`  |
| List item      | `log.item(text)`            |
| 2-space indent | `INDENT = '  '` constant    |
