// @effect-diagnostics nodeBuiltinImport:off
/**
 * SQLite reader for OpenCode's `opencode.db`.
 *
 * OpenCode stores all session history in `~/.local/share/opencode/opencode.db`
 * (Linux) / `~/Library/Application Support/opencode/opencode.db` (macOS). The
 * `message` table holds one row per user/assistant message with JSON `data`
 * containing `tokens`, `cost`, `modelID`, etc. We scan that table directly
 * rather than the file-based transcript approach used for Claude/Codex/Grok.
 *
 * @module usageOpenCodeDb
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { UsageRecord } from "./usageTranscripts.ts";
import { parseOpenCodeMessage } from "./usageTranscripts.ts";

/**
 * Resolves the OpenCode database path.
 *
 * Checks in order:
 * 1. `$OPENCODE_DATA_DIR/opencode.db` if set
 * 2. `$XDG_DATA_HOME/opencode/opencode.db` if `XDG_DATA_HOME` set
 * 3. `~/.local/share/opencode/opencode.db` (Linux)
 * 4. `~/Library/Application Support/opencode/opencode.db` (macOS fallback)
 *
 * Returns the first path that exists, or `null` if none exist.
 */
export async function resolveOpenCodeDbPath(): Promise<string | null> {
  const candidates: string[] = [];

  const dataDirEnv = process.env.OPENCODE_DATA_DIR?.trim();
  if (dataDirEnv && dataDirEnv.length > 0) {
    candidates.push(NodePath.join(dataDirEnv, "opencode.db"));
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome && xdgDataHome.length > 0) {
    candidates.push(NodePath.join(xdgDataHome, "opencode", "opencode.db"));
  }

  candidates.push(NodePath.join(NodeOS.homedir(), ".local", "share", "opencode", "opencode.db"));
  candidates.push(
    NodePath.join(NodeOS.homedir(), "Library", "Application Support", "opencode", "opencode.db"),
  );
  // Also check XDG on macOS via ~/.local/share
  // And legacy ~/.opencode
  candidates.push(NodePath.join(NodeOS.homedir(), ".opencode", "opencode.db"));

  for (const candidate of candidates) {
    try {
      await NodeFS.promises.access(candidate, NodeFS.constants.R_OK);
      return candidate;
    } catch {
      // not accessible, try next
    }
  }
  return null;
}

/**
 * Reads OpenCode message records from the SQLite database.
 *
 * Opens the database read-only so the live OpenCode server can continue
 * writing with WAL. Returns `null` if the file cannot be opened or the
 * schema is unexpected; an empty array if the file exists but has no
 * relevant rows. Caller is responsible for caching by `(size, mtime)`.
 */
export async function readOpenCodeDbRecords(
  dbPath: string,
): Promise<readonly UsageRecord[] | null> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    const sqlite = await import("node:sqlite");
    DatabaseSync = sqlite.DatabaseSync;
  } catch {
    return null;
  }

  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
  } catch {
    return null;
  }

  try {
    // Verify table exists
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'")
      .get() as { name: string } | undefined;
    if (!tableCheck) return [];

    const stmt = db.prepare("SELECT id, session_id, data FROM message");
    const rows = stmt.all() as Array<{ id: string; session_id: string; data: string }>;
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = parseOpenCodeMessage(row.data, row.id, row.session_id);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Gets file stats for caching (size, mtime) for the OpenCode DB.
 */
export async function statOpenCodeDb(
  dbPath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await NodeFS.promises.stat(dbPath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Reads the directory `device:inode` for fingerprinting the OpenCode DB source.
 */
export async function readOpenCodeDbVolumeId(dbPath: string): Promise<string> {
  try {
    const dir = NodePath.dirname(dbPath);
    const stats = await NodeFS.promises.stat(dir);
    const dev = (stats as unknown as { dev: number }).dev ?? 0;
    const ino = (stats as unknown as { ino: number }).ino ?? 0;
    return `${dev}:${ino}`;
  } catch {
    return "";
  }
}
