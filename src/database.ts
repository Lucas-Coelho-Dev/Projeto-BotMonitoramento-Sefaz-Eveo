/**
 * database.ts — Persistência de status em SQLite
 *
 * Tabela única: monitor_status
 *   Uma linha por serviço monitorado, atualizada a cada ciclo.
 *
 * Colunas:
 *   monitor_name    — nome do serviço (PK)
 *   status          — "online" | "instável" | "offline"
 *   previous_status — status anterior à última mudança
 *   response_ms     — tempo de resposta em ms
 *   detail          — detalhe textual do último check
 *   updated_at      — timestamp da última verificação (muda a cada minuto)
 *   changed_at      — timestamp da última MUDANÇA de status
 *
 * O outro sistema detecta mudança comparando status ou changed_at.
 * updated_at garante que o bot está vivo (para de mudar se o processo morrer).
 */

import Database from "better-sqlite3";
import path from "path";
import logger from "./logger";

const DB_PATH = path.join(process.cwd(), "monitor_status.db");
let db: Database.Database;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS monitor_status (
    monitor_name     TEXT NOT NULL PRIMARY KEY,
    status           TEXT NOT NULL,
    previous_status  TEXT,
    response_ms      INTEGER,
    detail           TEXT,
    updated_at       TEXT NOT NULL,
    changed_at       TEXT NOT NULL
  );
`;

// changed_at só é atualizado quando o status muda de fato
const UPSERT = `
  INSERT INTO monitor_status
    (monitor_name, status, previous_status, response_ms, detail, updated_at, changed_at)
  VALUES
    (@name, @status, @previous, @ms, @detail, @now, @now)
  ON CONFLICT(monitor_name) DO UPDATE SET
    previous_status = CASE
      WHEN excluded.status != monitor_status.status
      THEN monitor_status.status
      ELSE monitor_status.previous_status
    END,
    changed_at = CASE
      WHEN excluded.status != monitor_status.status
      THEN excluded.updated_at
      ELSE monitor_status.changed_at
    END,
    status      = excluded.status,
    response_ms = excluded.response_ms,
    detail      = excluded.detail,
    updated_at  = excluded.updated_at;
`;

export interface MonitorRow {
  monitor_name: string;
  status: string;
  previous_status: string | null;
  response_ms: number | null;
  detail: string | null;
  updated_at: string;
  changed_at: string;
}

/** Inicializa o banco e cria as tabelas se não existirem. */
export function initDb(): void {
  db = new Database(DB_PATH);
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INCIDENT_TABLE);
  logger.info(`Banco de dados inicializado: ${DB_PATH}`);
}

/** Grava ou atualiza o status de um monitor. Chamado a cada ciclo. */
export function saveStatus(
  monitorName: string,
  status: string,
  responseMs: number | null,
  detail: string
): void {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  try {
    db.prepare(UPSERT).run({
      name: monitorName,
      status,
      previous: null, // preenchido automaticamente pelo ON CONFLICT
      ms: responseMs,
      detail: detail || "",
      now,
    });
  } catch (err) {
    logger.error(`Erro ao salvar status de '${monitorName}': ${err}`);
  }
}

/**
 * Lê o status salvo de um monitor específico.
 * Usado na inicialização para restaurar o estado e evitar alertas falsos.
 * Retorna null se o monitor ainda não tiver sido registrado.
 */
export function readStatus(monitorName: string): string | null {
  try {
    const row = db
      .prepare("SELECT status FROM monitor_status WHERE monitor_name = ?")
      .get(monitorName) as { status: string } | undefined;
    return row?.status ?? null;
  } catch (err) {
    logger.error(`Erro ao ler status de '${monitorName}': ${err}`);
    return null;
  }
}

/** Retorna todas as linhas da tabela — usado no comando !dbstatus. */
export function readAll(): MonitorRow[] {
  try {
    return db
      .prepare("SELECT * FROM monitor_status ORDER BY monitor_name")
      .all() as MonitorRow[];
  } catch (err) {
    logger.error(`Erro ao ler tabela: ${err}`);
    return [];
  }
}

// ── Incident Log ─────────────────────────────────────────────────────────────

const CREATE_INCIDENT_TABLE = `
  CREATE TABLE IF NOT EXISTS incident_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_name  TEXT NOT NULL,
    status        TEXT NOT NULL,
    detail        TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    duration_sec  INTEGER
  );
`;

export interface IncidentRow {
  id: number;
  monitor_name: string;
  status: string;
  detail: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
}

/** Abre um novo incidente (queda ou instabilidade). */
export function openIncident(monitorName: string, status: string, detail: string): void {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  try {
    db.prepare(
      `INSERT INTO incident_log (monitor_name, status, detail, started_at)
       VALUES (?, ?, ?, ?)`
    ).run(monitorName, status, detail || "", now);
    logger.info(`Incidente aberto para '${monitorName}': ${status}`);
  } catch (err) {
    logger.error(`Erro ao abrir incidente para '${monitorName}': ${err}`);
  }
}

/** Fecha o incidente aberto mais recente de um monitor. */
export function closeIncident(monitorName: string): void {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  try {
    const open = db.prepare(
      `SELECT id, started_at FROM incident_log
       WHERE monitor_name = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`
    ).get(monitorName) as { id: number; started_at: string } | undefined;

    if (open) {
      const startMs = new Date(open.started_at.replace(" ", "T") + "Z").getTime();
      const endMs = new Date(now.replace(" ", "T") + "Z").getTime();
      const durationSec = Math.round((endMs - startMs) / 1000);

      db.prepare(
        `UPDATE incident_log SET ended_at = ?, duration_sec = ? WHERE id = ?`
      ).run(now, durationSec, open.id);
      logger.info(`Incidente #${open.id} fechado para '${monitorName}' (${durationSec}s)`);
    }
  } catch (err) {
    logger.error(`Erro ao fechar incidente para '${monitorName}': ${err}`);
  }
}

/** Verifica se há incidente aberto para um monitor. */
export function hasActiveIncident(monitorName: string): boolean {
  try {
    const row = db.prepare(
      `SELECT id FROM incident_log WHERE monitor_name = ? AND ended_at IS NULL LIMIT 1`
    ).get(monitorName);
    return !!row;
  } catch {
    return false;
  }
}

/** Retorna incidentes desde um timestamp ISO (para o relatório matinal). */
export function getIncidentsSince(sinceIso: string): IncidentRow[] {
  try {
    return db.prepare(
      `SELECT * FROM incident_log
       WHERE started_at >= ? OR (ended_at IS NOT NULL AND ended_at >= ?) OR ended_at IS NULL
       ORDER BY started_at DESC`
    ).all(sinceIso, sinceIso) as IncidentRow[];
  } catch (err) {
    logger.error(`Erro ao buscar incidentes: ${err}`);
    return [];
  }
}