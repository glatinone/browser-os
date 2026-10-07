import { MASKED_VALUE } from '@browser-os/protocol';
import { beforeEach, expect, test } from 'vitest';
import { openStore, type Store } from '../src/store.js';
import { AuditStore } from '../src/stores/audit-store.js';

const HOUR = 3_600_000;

interface AuditRow {
  id: number;
  kind: string;
  session_id: string | null;
  task_id: string | null;
  origin: string | null;
  risk: string | null;
  summary_json: string;
}

let open: Store;
let audits: AuditStore;

function count(): number {
  return (open.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
}

function firstRow(): AuditRow {
  return open.db.prepare('SELECT * FROM audit_log ORDER BY id DESC').get() as AuditRow;
}

beforeEach(() => {
  open = openStore(':memory:');
  audits = new AuditStore(open.db);
});

test('insert stores a masked summary verbatim', () => {
  const id = audits.insert({
    kind: 'human_correction',
    sessionId: 's1',
    taskId: 't1',
    origin: 'https://example.com',
    risk: 'medium',
    summary: { action: 'fill', field: 'password', value: MASKED_VALUE },
  });
  expect(id).toBeGreaterThan(0);

  const row = open.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as AuditRow;
  expect(row.kind).toBe('human_correction');
  expect(row.risk).toBe('medium');
  expect(JSON.parse(row.summary_json)).toEqual({
    action: 'fill',
    field: 'password',
    value: MASKED_VALUE,
  });
});

test('rejects an unmasked string under a value or secret key', () => {
  expect(() => audits.insert({ kind: 'x', summary: { value: 'hunter2' } })).toThrow('INTERNAL');

  expect(() => audits.insert({ kind: 'x', summary: { details: { secret: 'hunter2' } } })).toThrow('INTERNAL');

  expect(() => audits.insert({ kind: 'x', summary: { list: [{ value: 'hunter2' }] } })).toThrow('INTERNAL');

  expect(count()).toBe(0);
});

test('accepts masked, empty, non-string and reference values', () => {
  audits.insert({ kind: 'a', summary: { value: MASKED_VALUE } });
  audits.insert({ kind: 'b', summary: { value: '' } });
  audits.insert({ kind: 'c', summary: { value: 42 } });
  audits.insert({ kind: 'd', summary: { value: null } });
  audits.insert({ kind: 'e', summary: { value: { nested: true } } });
  audits.insert({ kind: 'f', summary: { secret: MASKED_VALUE } });
  // Key names that merely *contain* the words are not the forbidden keys.
  audits.insert({ kind: 'g', summary: { valueCount: 3, secretNames: ['password'] } });

  expect(count()).toBe(7);
});

test('optional fields default to NULL', () => {
  audits.insert({ kind: 'minimal', summary: {} });
  const row = firstRow();
  expect(row.session_id).toBeNull();
  expect(row.task_id).toBeNull();
  expect(row.origin).toBeNull();
  expect(row.risk).toBeNull();
});

test('prune drops only rows older than the retention window', () => {
  audits.insert({ kind: 'old', summary: {} }, Date.now() - 3 * HOUR);
  audits.insert({ kind: 'recent', summary: {} }, Date.now() - 30 * 60_000);

  expect(audits.prune(2 * HOUR)).toBe(1);
  expect(count()).toBe(1);
  const row = firstRow();
  expect(row.kind).toBe('recent');
  expect(audits.prune(2 * HOUR)).toBe(0);
});
