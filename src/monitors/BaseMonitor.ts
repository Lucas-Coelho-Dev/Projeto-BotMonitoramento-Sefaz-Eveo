/**
 * monitors/BaseMonitor.ts — Classe base abstrata para todos os monitores.
 *
 * Subclasses devem implementar fetchStatus().
 * Todo o restante (banco, alertas, logging) é herdado automaticamente.
 */

import { config } from "../config";
import { saveStatus, readStatus } from "../database";
import { getLogger } from "../logger";

export const ONLINE        = "online";
export const UNSTABLE      = "instável";
export const OFFLINE       = "offline";
export const UNKNOWN       = "desconhecido";
export const INDETERMINATE = "indeterminado";
 
export const STATUS_EMOJI: Record<string, string> = {
  [ONLINE]:        "✅",
  [UNSTABLE]:      "⚠️",
  [OFFLINE]:       "🔴",
  [UNKNOWN]:       "❓",
  [INDETERMINATE]: "🔘",
};
 
export const STATUS_COLOR: Record<string, number> = {
  [ONLINE]:        0x2ecc71,
  [UNSTABLE]:      0xe67e22,
  [OFFLINE]:       0xe74c3c,
  [UNKNOWN]:       0x95a5a6,
  [INDETERMINATE]: 0x7f8c8d,
};
 
/**
 * Retorna o horário atual formatado no fuso de Brasília (UTC-3).
 * Usa Intl para evitar o problema de double-offset no Windows:
 *   - new Date() já é UTC internamente
 *   - toTimeString() aplica o timezone local do SO, causando duplo offset
 */
export function nowBrasilia(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour:   "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}
 
/** Retorna Date atual em UTC (para setTimestamp do Discord — ele converte automaticamente). */
export function nowUtc(): Date {
  return new Date();
}
 
export type FetchResult = [string, number | null, string];
 
export interface INotifier {
  sendAlert(
    monitor: BaseMonitor,
    newStatus: string,
    previousStatus: string,
    responseMs: number | null,
    detail: string
  ): Promise<void>;
}
 
export abstract class BaseMonitor {
  readonly displayName: string;
  protected log;
  protected notifier: INotifier;
 
  _status: string;
  private badCount = 0;         // contador de ciclos consecutivos com status != ONLINE
  lastMentionAt = 0;            // timestamp da última menção (@everyone/roles) enviada para este monitor
  _responseMs: number | null = null;
  _lastChecked: string | null = null; // horário formatado em Brasília
  _detail = "";
 
  constructor(notifier: INotifier, displayName: string) {
    this.notifier    = notifier;
    this.displayName = displayName;
    this.log         = getLogger(displayName);
 
    const saved  = readStatus(displayName);
    this._status = saved ?? UNKNOWN;
    if (saved) this.log.info(`Estado restaurado do banco: ${saved.toUpperCase()}`);
  }
 
  async check(): Promise<void> {
    const [rawStatus, responseMs, detail] = await this.fetchStatus();
    this._responseMs  = responseMs;
    this._lastChecked = nowBrasilia();
    this._detail      = detail || "";
 
    // Fontes indisponíveis → mantém status anterior (não conta como ciclo ruim)
    if (rawStatus === UNKNOWN || rawStatus === INDETERMINATE) {
      this.log.warn(`Fontes indisponíveis — mantendo status anterior: ${this._status.toUpperCase()}`);
      saveStatus(this.displayName, this._status, responseMs, detail);
      return;
    }
 
    // ── Lógica Anti-Flapping / Debounce ──────────────────────────────────
    // Se estava ONLINE e deu problema -> exige 3 confirmações para alertar queda
    // Se estava com PROBLEMA e deu ONLINE -> exige 2 confirmações para declarar recuperado
    let effective: string;

    if (rawStatus === ONLINE) {
      if (this._status !== ONLINE) {
        // Estava instável/offline e deu OK -> precisa de 2 ciclos OK para confirmar recuperação
        this.badCount++;
        if (this.badCount < 2) {
          this.log.info(
            `Aguardando confirmação de recuperação (${this.badCount}/2 ciclos ONLINE)`
          );
          effective = this._status; // Mantém o estado de problema até confirmar que realmente estabilizou
        } else {
          this.badCount = 0;
          effective = ONLINE; // Recuperação confirmada após 2 minutos estáveis!
        }
      } else {
        this.badCount = 0;
        effective = ONLINE;
      }
    } else {
      // rawStatus é INSTÁVEL ou OFFLINE
      if (this._status === ONLINE) {
        this.badCount++;
        if (this.badCount < config.UNSTABLE_CONSECUTIVE_CHECKS) {
          this.log.info(
            `Filtro Anti-Flapping: Falha detectada (${rawStatus.toUpperCase()}) — ` +
            `Aguardando confirmação (${this.badCount}/${config.UNSTABLE_CONSECUTIVE_CHECKS})`
          );
          effective = ONLINE; // Mantém estado ONLINE no canal durante a janela de tolerância
        } else {
          this.badCount = 0;
          effective = rawStatus; // Falha confirmada após 3 ciclos (3 minutos)
        }
      } else {
        // Se já se encontrava em falha, zera contador e atualiza para o novo estado de falha se mudou
        this.badCount = 0;
        effective = rawStatus;
      }
    }
 
    this.log.info(
      `Status: ${effective.toUpperCase()} | ` +
      `Resposta: ${responseMs}ms | ` +
      `Anterior: ${this._status}`
    );
 
    // Persiste o estado resultante na tabela SQLite 'monitor_status'
    saveStatus(this.displayName, effective, responseMs, this._detail);
 
    // ── Processamento de Transição de Estado ───────────────────────────
    if (effective !== this._status) {
      const previous = this._status;
      this._status   = effective;

      // ── Histórico de Incidentes em SQLite ──────────────────────────────────
      if (previous === ONLINE && (effective === OFFLINE || effective === UNSTABLE)) {
        const { openIncident } = require("../database");
        openIncident(this.displayName, effective, this._detail);
      }
      else if ((previous === OFFLINE || previous === UNSTABLE) && effective === ONLINE) {
        const { closeIncident } = require("../database");
        closeIncident(this.displayName);
      }
      else if ((previous === OFFLINE || previous === UNSTABLE) && (effective === OFFLINE || effective === UNSTABLE)) {
        const { closeIncident, openIncident } = require("../database");
        closeIncident(this.displayName);
        openIncident(this.displayName, effective, this._detail);
      }
      // ────────────────────────────────────────────────────────────────────────

      // Dispara o alerta no Discord para a mudança de estado confirmada
      await this.notifier.sendAlert(this, effective, previous, responseMs, this._detail);
    }
  }

  statusField(): string {
    const emoji  = STATUS_EMOJI[this._status] ?? "❓";
    const ms     = this._responseMs !== null ? `${this._responseMs}ms` : "N/A";
    const last   = this._lastChecked ?? "Nunca";
    const detail = this._detail ? `\n> ${this._detail}` : "";
    return `${emoji} **${this._status.toUpperCase()}**\nResposta: \`${ms}\` • Verificado: \`${last}\`${detail}`;
  }
 
  abstract fetchStatus(): Promise<FetchResult>;
}