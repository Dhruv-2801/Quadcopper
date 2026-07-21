#!/usr/bin/env python3
"""
Writer: batches incoming force-plate records into SQLite and automatically
opens/closes cow sessions from the combined live plate weight.
"""
import argparse
import json
import os
import queue
import signal
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Dict, Optional

# ====== CONFIG ======
APP_DIR = Path(__file__).resolve().parent
DEFAULT_DB = APP_DIR / "data" / "forceplate.db"
DB_PATH = os.environ.get("FORCEPLATE_DB", str(DEFAULT_DB))
BATCH_SIZE = 64
BATCH_MS = 200
BUSY_TIMEOUT_MS = 2000

SESSION_THRESHOLD_LBS = float(os.environ.get("COW_SESSION_THRESHOLD_LBS", "100"))
SESSION_START_DELAY_S = float(os.environ.get("COW_SESSION_START_DELAY_S", "5"))
SESSION_STOP_DELAY_S = float(os.environ.get("COW_SESSION_STOP_DELAY_S", "10"))
ACTIVE_PLATE_STALE_S = float(os.environ.get("ACTIVE_PLATE_STALE_S", "2"))
# ====================

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS cow_session (
  cow_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  start_time  INTEGER NOT NULL,
  stop_time   INTEGER
);

CREATE TABLE IF NOT EXISTS measurements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id          TEXT NOT NULL,
  plate           TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  ts_utc_ms       INTEGER NOT NULL,
  weight_lbs      REAL NOT NULL,
  raw_weight_lbs  REAL,
  tare_offset_lbs REAL DEFAULT 0,
  cow_id          INTEGER,
  FOREIGN KEY (cow_id) REFERENCES cow_session(cow_id)
);

CREATE INDEX IF NOT EXISTS idx_meas_set_plate_ts
  ON measurements(set_id, plate, ts_utc_ms);
CREATE INDEX IF NOT EXISTS idx_meas_cow_ts
  ON measurements(cow_id, ts_utc_ms);
CREATE INDEX IF NOT EXISTS idx_cow_session_open
  ON cow_session(stop_time);
"""


def _table_columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in con.execute(f"PRAGMA table_info({table})").fetchall()}


def _migrate_grams_to_weight_lbs(con: sqlite3.Connection) -> None:
    cols = _table_columns(con, "measurements")
    if "grams" in cols and "weight_lbs" not in cols:
        con.execute("ALTER TABLE measurements RENAME COLUMN grams TO weight_lbs;")
        con.commit()
        print("[writer] migrated column grams -> weight_lbs", file=sys.stderr)


def _migrate_measurement_columns(con: sqlite3.Connection) -> None:
    cols = _table_columns(con, "measurements")
    if "raw_weight_lbs" not in cols:
        con.execute("ALTER TABLE measurements ADD COLUMN raw_weight_lbs REAL;")
        print("[writer] migrated: added raw_weight_lbs", file=sys.stderr)
    if "tare_offset_lbs" not in cols:
        con.execute("ALTER TABLE measurements ADD COLUMN tare_offset_lbs REAL DEFAULT 0;")
        print("[writer] migrated: added tare_offset_lbs", file=sys.stderr)
    if "cow_id" not in cols:
        con.execute(
            "ALTER TABLE measurements ADD COLUMN cow_id INTEGER REFERENCES cow_session(cow_id);"
        )
        print("[writer] migrated: added cow_id", file=sys.stderr)
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_meas_cow_ts ON measurements(cow_id, ts_utc_ms);"
    )
    con.commit()


def utc_ms_now() -> int:
    return time.time_ns() // 1_000_000


def load_mapping(path: Optional[str]) -> Dict[str, str]:
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as file:
            mapping = json.load(file)
            return {str(key): str(value) for key, value in mapping.items()}
    except Exception as exc:
        print(f"[writer] WARN: failed to load mapping {path}: {exc}", file=sys.stderr)
        return {}


def split_set_and_plate(device_id: str):
    parts = device_id.split("_")
    set_id = "_".join(parts[:2]) if len(parts) >= 3 else device_id
    return set_id, device_id


class CowSessionTracker:
    """Debounced threshold detector using the latest reading from every live plate."""

    def __init__(self, con: sqlite3.Connection):
        self.con = con
        self.latest: dict[str, tuple[float, int]] = {}
        self.active_cow_id: Optional[int] = None
        self.start_candidate_ms: Optional[int] = None
        self.stop_candidate_ms: Optional[int] = None
        self._restore_open_session()

    def _restore_open_session(self) -> None:
        row = self.con.execute(
            "SELECT cow_id FROM cow_session WHERE stop_time IS NULL ORDER BY cow_id DESC LIMIT 1"
        ).fetchone()
        if row:
            self.active_cow_id = int(row[0])
            print(f"[session] restored active cow_id={self.active_cow_id}", file=sys.stderr)

    def total_weight(self, now_ms: int) -> float:
        stale_before = now_ms - int(ACTIVE_PLATE_STALE_S * 1000)
        stale = [plate for plate, (_, ts_ms) in self.latest.items() if ts_ms < stale_before]
        for plate in stale:
            self.latest.pop(plate, None)
        return sum(weight for weight, _ in self.latest.values())

    def process(self, plate: str, weight_lbs: float, ts_ms: int):
        self.latest[plate] = (max(0.0, weight_lbs), ts_ms)
        total = self.total_weight(ts_ms)
        event = None

        if self.active_cow_id is None:
            self.stop_candidate_ms = None
            if total > SESSION_THRESHOLD_LBS:
                if self.start_candidate_ms is None:
                    self.start_candidate_ms = ts_ms
                elapsed = ts_ms - self.start_candidate_ms
                if elapsed >= int(SESSION_START_DELAY_S * 1000):
                    start_ms = self.start_candidate_ms
                    cur = self.con.execute(
                        "INSERT INTO cow_session(start_time, stop_time) VALUES (?, NULL)",
                        (start_ms,),
                    )
                    self.active_cow_id = int(cur.lastrowid)
                    # Include already-written measurements from the debounce interval.
                    self.con.execute(
                        "UPDATE measurements SET cow_id = ? "
                        "WHERE cow_id IS NULL AND ts_utc_ms >= ? AND ts_utc_ms <= ?",
                        (self.active_cow_id, start_ms, ts_ms),
                    )
                    self.con.commit()
                    event = ("started", self.active_cow_id, start_ms)
                    self.start_candidate_ms = None
                    print(
                        f"[session] START cow_id={self.active_cow_id} total={total:.1f} lb",
                        file=sys.stderr,
                    )
            else:
                self.start_candidate_ms = None
        else:
            self.start_candidate_ms = None
            if total < SESSION_THRESHOLD_LBS:
                if self.stop_candidate_ms is None:
                    self.stop_candidate_ms = ts_ms
                elapsed = ts_ms - self.stop_candidate_ms
                if elapsed >= int(SESSION_STOP_DELAY_S * 1000):
                    cow_id = self.active_cow_id
                    stop_ms = self.stop_candidate_ms
                    self.con.execute(
                        "UPDATE cow_session SET stop_time = ? WHERE cow_id = ? AND stop_time IS NULL",
                        (stop_ms, cow_id),
                    )
                    # Readings after the first confirmed below-threshold instant are not part
                    # of the completed cow visit.
                    self.con.execute(
                        "UPDATE measurements SET cow_id = NULL "
                        "WHERE cow_id = ? AND ts_utc_ms > ?",
                        (cow_id, stop_ms),
                    )
                    self.con.commit()
                    self.active_cow_id = None
                    self.stop_candidate_ms = None
                    event = ("stopped", cow_id, stop_ms)
                    print(
                        f"[session] STOP cow_id={cow_id} total={total:.1f} lb",
                        file=sys.stderr,
                    )
            else:
                self.stop_candidate_ms = None

        return self.active_cow_id, total, event


class Writer:
    def __init__(self, db_path: str, plate_map: Dict[str, str]):
        self.db_path = db_path
        self.plate_map = plate_map
        self.queue = queue.Queue(maxsize=10_000)
        self.stop = threading.Event()
        self._setup_db()

    def _configure_connection(self, con: sqlite3.Connection) -> None:
        con.execute("PRAGMA foreign_keys=ON;")
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("PRAGMA synchronous=NORMAL;")
        con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS};")
        con.execute("PRAGMA temp_store=MEMORY;")
        con.execute("PRAGMA mmap_size=268435456;")

    def _setup_db(self):
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        con = sqlite3.connect(self.db_path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
        try:
            self._configure_connection(con)
            con.executescript(SCHEMA_SQL)
            _migrate_grams_to_weight_lbs(con)
            _migrate_measurement_columns(con)
        finally:
            con.close()

    def reader_thread(self):
        for line in sys.stdin:
            if self.stop.is_set():
                break
            raw_line = line.strip()
            if not raw_line:
                continue
            try:
                try:
                    obj = json.loads(raw_line)
                except json.JSONDecodeError:
                    cleaned = raw_line.lstrip("\ufeff")
                    try:
                        obj = json.loads(cleaned)
                    except json.JSONDecodeError:
                        start, end = raw_line.find("{"), raw_line.rfind("}")
                        if start == -1 or end <= start:
                            raise
                        obj = json.loads(raw_line[start : end + 1])

                device_id = str(obj.get("device_id") or obj.get("dev") or "")
                value = obj.get("weight")
                if not device_id or value is None:
                    print(f"[writer] SKIP malformed: {raw_line}", file=sys.stderr)
                    continue

                raw_value = obj.get("raw_weight", value)
                offset_value = obj.get("tare_offset", 0)
                set_id, plate_name = split_set_and_plate(device_id)
                plate_name = self.plate_map.get(device_id, plate_name)
                ts_ms = utc_ms_now()
                self.queue.put(
                    (
                        set_id,
                        plate_name,
                        device_id,
                        ts_ms,
                        float(value),
                        float(raw_value),
                        float(offset_value),
                    )
                )
            except Exception as exc:
                print(f"[writer] SKIP parse error: {exc} | line={raw_line}", file=sys.stderr)
        self.stop.set()

    def db_thread(self):
        con = sqlite3.connect(self.db_path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
        self._configure_connection(con)
        tracker = CowSessionTracker(con)
        cur = con.cursor()

        pending = []
        last_commit = time.monotonic()
        insert_sql = (
            "INSERT INTO measurements "
            "(set_id, plate, device_id, ts_utc_ms, weight_lbs, raw_weight_lbs, tare_offset_lbs, cow_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )

        def flush():
            nonlocal pending, last_commit
            if not pending:
                return
            try:
                cur.execute("BEGIN IMMEDIATE;")
                cur.executemany(insert_sql, pending)
                con.commit()
                pending.clear()
                last_commit = time.monotonic()
            except sqlite3.OperationalError as exc:
                con.rollback()
                print(f"[writer] WARN: DB busy on commit, retrying: {exc}", file=sys.stderr)
                time.sleep(0.05)
            except Exception as exc:
                con.rollback()
                print(f"[writer] ERROR: commit failed: {exc}", file=sys.stderr)

        while not self.stop.is_set():
            wait_ms = max(0, BATCH_MS - int((time.monotonic() - last_commit) * 1000))
            try:
                item = self.queue.get(timeout=wait_ms / 1000 if wait_ms > 0 else 0.001)
                set_id, plate, device_id, ts_ms, value, raw_value, offset_value = item
                cow_id, _total, event = tracker.process(plate, value, ts_ms)

                if event and event[0] == "started":
                    _, started_cow_id, start_ms = event
                    pending = [
                        row[:-1] + (started_cow_id,)
                        if row[3] >= start_ms and row[-1] is None
                        else row
                        for row in pending
                    ]
                elif event and event[0] == "stopped":
                    _, stopped_cow_id, stop_ms = event
                    pending = [
                        row[:-1] + (None,)
                        if row[-1] == stopped_cow_id and row[3] > stop_ms
                        else row
                        for row in pending
                    ]

                pending.append(
                    (set_id, plate, device_id, ts_ms, value, raw_value, offset_value, cow_id)
                )
                if len(pending) >= BATCH_SIZE:
                    flush()
            except queue.Empty:
                flush()

        flush()
        con.close()

    def run(self):
        reader = threading.Thread(target=self.reader_thread, daemon=True)
        database = threading.Thread(target=self.db_thread, daemon=True)
        reader.start()
        database.start()

        def stop_handler(_signal, _frame):
            self.stop.set()

        signal.signal(signal.SIGINT, stop_handler)
        signal.signal(signal.SIGTERM, stop_handler)

        while not self.stop.is_set():
            time.sleep(10)
            print(f"[writer] q={self.queue.qsize()}", file=sys.stderr)

        reader.join(timeout=2)
        database.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", default=None, help="JSON mapping device_id -> plate name")
    args = parser.parse_args()
    Writer(DB_PATH, load_mapping(args.map)).run()


if __name__ == "__main__":
    main()
