export interface ParsedIntent {
  tokens: string[];
  exact: string | null;
  roleHints: string[];
  searchBonus: boolean;
}

const LEADING_VERBS = new Set([
  'click',
  'press',
  'tap',
  'select',
  'choose',
  'open',
  'type',
  'fill',
  'enter',
  'hover',
  'check',
  'uncheck',
]);
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'on',
  'in',
  'into',
  'to',
  'of',
  'for',
  'with',
  'at',
  'please',
]);

const ROLE_HINTS: ReadonlyArray<readonly [string[], string[]]> = [
  [
    ['search', 'box'],
    ['searchbox', 'combobox', 'textbox'],
  ],
  [
    ['search', 'field'],
    ['searchbox', 'combobox', 'textbox'],
  ],
  [
    ['search', 'bar'],
    ['searchbox', 'combobox', 'textbox'],
  ],
  [
    ['menu', 'item'],
    ['menuitem', 'button'],
  ],
  [['check', 'box'], ['checkbox']],
  [
    ['text', 'box'],
    ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  ],
  [['button'], ['button']],
  [['btn'], ['button']],
  [['link'], ['link']],
  [['field'], ['textbox', 'searchbox', 'combobox', 'spinbutton']],
  [['input'], ['textbox', 'searchbox', 'combobox', 'spinbutton']],
  [['box'], ['textbox', 'searchbox', 'combobox', 'spinbutton']],
  [['textbox'], ['textbox', 'searchbox', 'combobox', 'spinbutton']],
  [['checkbox'], ['checkbox']],
  [['radio'], ['radio']],
  [['dropdown'], ['combobox', 'listbox']],
  [['select'], ['combobox', 'listbox']],
  [['combo'], ['combobox', 'listbox']],
  [['combobox'], ['combobox', 'listbox']],
  [['tab'], ['tab']],
  [['menu'], ['menuitem', 'button']],
  [['toggle'], ['switch', 'checkbox']],
  [['switch'], ['switch', 'checkbox']],
];

export function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function truncate(value: string, length: number): string {
  if (length <= 0) return '';
  const text = collapse(value);
  if (text.length <= length) return text;
  if (length === 1) return '…';
  return `${text.slice(0, length - 1)}…`;
}

export function normalizeName(value: string): string {
  return collapse(value).toLowerCase().replace(/\d+/gu, '#');
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function prefixMatch(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

export function dice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matches = new Array<number>(a.length).fill(-1);
  const visit = (left: number, seen: Set<number>): boolean => {
    const leftToken = a[left] as string;
    for (let right = 0; right < b.length; right += 1) {
      const rightToken = b[right] as string;
      const matchedLeft = matches[right] as number;
      if (seen.has(right) || !prefixMatch(leftToken, rightToken)) continue;
      seen.add(right);
      if (matchedLeft === -1 || visit(matchedLeft, seen)) {
        matches[right] = left;
        return true;
      }
    }
    return false;
  };

  let overlap = 0;
  for (let left = 0; left < a.length; left += 1) {
    if (visit(left, new Set())) overlap += 1;
  }
  return (2 * overlap) / (a.length + b.length);
}

function quotedIntent(value: string): { text: string; exact: string | null } {
  let exact: string | null = null;
  const text = value.replace(/["']([^"']*)["']/gu, (_match, quoted: string) => {
    if (exact === null) exact = collapse(quoted);
    return ' ';
  });
  return { text, exact };
}

export function parseIntent(value: string): ParsedIntent {
  const { text: unquoted, exact } = quotedIntent(value);
  const words = tokenize(unquoted);
  const roleHints = new Set<string>();
  const removed = new Set<number>();
  let searchBonus = false;

  for (const [phrase, roles] of ROLE_HINTS) {
    for (let i = 0; i <= words.length - phrase.length; i += 1) {
      if (
        phrase.every((word, offset) => words[i + offset] === word) &&
        !phrase.some((_word, offset) => removed.has(i + offset))
      ) {
        phrase.forEach((_word, offset) => {
          removed.add(i + offset);
        });
        roles.forEach((role) => {
          roleHints.add(role);
        });
        if (phrase[0] === 'search') searchBonus = true;
      }
    }
  }

  const tokens = words.filter(
    (word, index) => !removed.has(index) && !STOP_WORDS.has(word) && !LEADING_VERBS.has(word),
  );
  return { tokens, exact, roleHints: [...roleHints], searchBonus };
}
