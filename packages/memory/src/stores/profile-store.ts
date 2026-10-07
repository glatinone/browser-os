import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../migrate.js';

export interface Profile {
  id: string;
  name: string;
  channel: 'chrome' | 'msedge' | 'chromium';
  user_data_dir: string;
  headless: number;
  created_at: number;
  last_used_at: number | null;
}

export class ProfileStore {
  constructor(private db: SqliteDatabase) {
    this.prepare();
  }

  private stmtCreate!: ReturnType<SqliteDatabase['prepare']>;
  private stmtGetByName!: ReturnType<SqliteDatabase['prepare']>;
  private stmtGetById!: ReturnType<SqliteDatabase['prepare']>;
  private stmtList!: ReturnType<SqliteDatabase['prepare']>;
  private stmtDelete!: ReturnType<SqliteDatabase['prepare']>;
  private stmtTouch!: ReturnType<SqliteDatabase['prepare']>;

  private prepare() {
    this.stmtCreate = this.db.prepare(
      `INSERT INTO profiles (id, name, channel, user_data_dir, headless, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetByName = this.db.prepare('SELECT * FROM profiles WHERE name = ?');
    this.stmtGetById = this.db.prepare('SELECT * FROM profiles WHERE id = ?');
    this.stmtList = this.db.prepare('SELECT * FROM profiles');
    this.stmtDelete = this.db.prepare('DELETE FROM profiles WHERE id = ?');
    this.stmtTouch = this.db.prepare('UPDATE profiles SET last_used_at = ? WHERE id = ?');
  }

  create(
    name: string,
    opts: { channel: Profile['channel']; user_data_dir: string; headless?: boolean } = {
      channel: 'chrome',
      user_data_dir: '',
    },
  ): Profile {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    try {
      this.stmtCreate.run(id, name, opts.channel, opts.user_data_dir, opts.headless ? 1 : 0, now, now);
    } catch {
      throw new Error('INVALID_REQUEST: profile name must be unique');
    }
    const created = this.getByName(name);
    if (!created) throw new Error('INTERNAL: profile row missing after insert');
    return created;
  }

  getByName(name: string): Profile | undefined {
    return this.stmtGetByName.get(name) as Profile | undefined;
  }

  getById(id: string): Profile | undefined {
    return this.stmtGetById.get(id) as Profile | undefined;
  }

  list(): Profile[] {
    return this.stmtList.all() as Profile[];
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }

  touch(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.stmtTouch.run(now, id);
  }
}
