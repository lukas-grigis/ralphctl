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

- Banner in `theme/index.ts` with ASCII art (has 🍩 donuts embedded in first and last lines)
- Random quotes via `getRandomQuote()`
- Donut emoji (`🍩`) used in banner, spinners, prompts
- Themed messages in `messages` object for actions

### Gradient System (gradient-string)

Uses `gradient-string` npm package for beautiful terminal gradients:

```typescript
import { gradients, applyGradient, applyGradientLines } from '@src/theme/index.ts';

// Apply gradient to single line
const coloredText = applyGradient('Hello World', gradients.donut);

// Apply gradient to multi-line text (each line gets its own gradient)
const coloredBanner = applyGradientLines(banner.art, gradients.donut);
```

**Available gradients:**

- `gradients.donut` - Yellow → Orange → Pink → Magenta (Ralph's signature)
- `gradients.success` - Green → Cyan
- `gradients.warning` - Red → Yellow
- `gradients.passion` - Warm colors preset from gradient-string
- `gradients.fruit` - Fruity colors preset
- `gradients.vice` - Neon colors preset

**Implementation:**

- Uses `gradient-string` for smooth color transitions (not discrete colorette stepping)
- Falls back to plain text when `isColorSupported` is false
- Empty lines are preserved without coloring

## UX Conventions

| Pattern        | Implementation              |
| -------------- | --------------------------- |
| Empty state    | `showEmpty(what, hint)`     |
| Success        | `showSuccess(msg, fields?)` |
| Error          | `showError(msg)`            |
| Next action    | `showNextStep(cmd, desc?)`  |
| List item      | `log.item(text)`            |
| 2-space indent | `INDENT = '  '` constant    |

## HITL (Human-In-The-Loop) Flow Pattern

**Use case:** Multi-step processes that iterate over entities with user decisions at each step.

**Example:** `sprint refine` - per-ticket requirements refinement.

### Flow Structure

```typescript
// 1. Initial summary
printHeader('Process Name', icons.entity);
console.log(field('Context', value));
log.newline();

// 2. Loop over entities
for (let i = 0; i < entities.length; i++) {
  const entity = entities[i];

  // Show entity card with progress
  printSeparator(60);
  console.log('');
  console.log(`  ${icons.entity}  ${info(`Entity ${i + 1} of ${entities.length}`)}`);
  console.log('');
  console.log(field('Name', entity.name));
  console.log(field('Details', entity.details));
  log.newline();

  // User decision point
  const proceed = await confirm({
    message: `${emoji.donut} Process this entity?`,
    default: true,
  });

  if (!proceed) {
    log.dim('Skipped.');
    skipped++;
    continue;
  }

  // Do work
  const spinner = createSpinner('Processing...');
  spinner.start();
  try {
    await doWork(entity);
    spinner.succeed('Completed');
    approved++;
  } catch (err) {
    spinner.fail('Failed');
    showError(err.message);
    skipped++;
  }

  log.newline();
}

// 3. Final summary
printSeparator(60);
log.newline();
printHeader('Summary', icons.success);
console.log(field('Approved', String(approved)));
console.log(field('Skipped', String(skipped)));
log.newline();
```

### Key Principles

1. **Progress visibility** - Show "N of M" counters
2. **Entity cards** - Clear visual separation with separators
3. **User control** - Offer skip/proceed at each step
4. **Spinner feedback** - Show async work progress
5. **Running counts** - Track approved/skipped
6. **Final summary** - Recap what happened

### Real Example

See `src/commands/sprint/refine.ts` for the per-ticket refinement flow.
