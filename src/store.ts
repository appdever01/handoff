import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Handoff, Session } from '../packages/contracts/index.ts';

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'handoff.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, message TEXT NOT NULL, currency TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, creator TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (handoff TEXT NOT NULL, wallet TEXT NOT NULL, PRIMARY KEY(handoff,wallet));
  `);
  return {
    db,
    get(id: string): Handoff | undefined {
      const row = db.prepare('SELECT data FROM handoffs WHERE id=?').get(id) as { data: string } | undefined;
      return row && JSON.parse(row.data);
    },
    save(handoff: Handoff) {
      db.prepare('INSERT INTO handoffs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(handoff.id, handoff.creator, JSON.stringify(handoff));
    },
    list(creator: string): Handoff[] {
      return (db.prepare('SELECT data FROM handoffs WHERE creator=? ORDER BY rowid DESC').all(creator) as { data: string }[]).map(row => JSON.parse(row.data));
    },
    session(hash: string): Session | undefined {
      const row = db.prepare('SELECT data FROM sessions WHERE hash=? AND expires>?').get(hash, Date.now()) as { data: string } | undefined;
      return row && JSON.parse(row.data);
    },
  };
}
export type Store = ReturnType<typeof openStore>;
