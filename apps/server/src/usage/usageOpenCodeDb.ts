// @effect-diagnostics nodeBuiltinImport:off - `node:sqlite` has no Effect wrapper, so this reader stays on Node built-ins; isolated here so the rest of the usage code keeps using Effect's FileSystem/Path.
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
export async function resolveOpenCodeDbPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates: string[] = [];

  const dataDirEnv = env.OPENCODE_DATA_DIR?.trim();
  if (dataDirEnv && dataDirEnv.length > 0) {
    candidates.push(NodePath.join(dataDirEnv, "opencode.db"));
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
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
 *
 * Reads both the legacy `message` table and the current `session_message`
 * table (OpenCode v2), unioning the results.
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
    const records: UsageRecord[] = [];
    const tables: string[] = [];
    try {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','session_message')",
        )
        .all() as Array<{ name: string }>;
      for (const row of rows) tables.push(row.name);
    } catch {
      return null;
    }
    if (tables.length === 0) return [];

    for (const table of tables) {
      try {
        // Use iterate() instead of all() to avoid loading all rows at once and to allow yielding.
        let rows: Iterable<Record<string, unknown>>;
        let isSessionMessage = table === "session_message";
        try {
          if (isSessionMessage) {
            const stmt = db.prepare(
              `SELECT id, session_id, type, time_created, time_updated, data FROM "${table}"`,
            );
            rows = stmt.iterate() as Iterable<Record<string, unknown>>;
          } else {
            const stmt = db.prepare(
              `SELECT id, session_id, time_created, time_updated, data FROM "${table}"`,
            );
            rows = stmt.iterate() as Iterable<Record<string, unknown>>;
          }
        } catch {
          // Fallback for older schemas without time columns
          const stmt = db.prepare(`SELECT id, session_id, data FROM "${table}"`);
          rows = stmt.iterate() as Iterable<Record<string, unknown>>;
          isSessionMessage = false;
        }
        let count = 0;
        for (const raw of rows) {
          const row = raw as {
            id: string;
            session_id: string;
            data: string;
            type?: string;
            time_created?: number;
            time_updated?: number;
          };
          const record = parseOpenCodeMessage(
            row.data,
            row.id,
            row.session_id,
            isSessionMessage ? row.type : undefined,
            row.time_created,
            row.time_updated,
          );
          if (record !== null) records.push(record);
          // Yield to event loop every 100 rows to avoid blocking cold scans.
          if (++count % 100 === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      } catch {
        // One table failing shouldn't hide the other; treat as empty for that table.
        continue;
      }
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
 * Gets file stats for caching (size, mtime) for the OpenCode DB, including WAL.
 *
 * When OpenCode runs in WAL mode, committed messages live in `opencode.db-wal`
 * while the main file's mtime/size can stay stale until a checkpoint. Including
 * the WAL's fingerprint ensures a refresh sees new rows immediately.
 */
export async function statOpenCodeDb(
  dbPath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await NodeFS.promises.stat(dbPath);
    let size = stats.size;
    let mtimeMs = stats.mtimeMs;
    // Include WAL file if present - its mtime/size changes on every committed write.
    const walPath = `${dbPath}-wal`;
    try {
      const walStats = await NodeFS.promises.stat(walPath);
      size += walStats.size;
      mtimeMs = Math.max(mtimeMs, walStats.mtimeMs);
    } catch {
      // No WAL file, that's fine.
    }
    // Also include shm for completeness, though its mtime is less meaningful.
    return { size, mtimeMs };
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
