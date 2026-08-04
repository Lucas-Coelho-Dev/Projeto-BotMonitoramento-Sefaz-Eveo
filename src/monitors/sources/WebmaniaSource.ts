/**
 * monitors/sources/WebmaniaSource.ts — Fonte primária: API pública Webmania
 *
 * Endpoint: GET https://monitorsefaz.webmaniabr.com/v2/components.json
 *
 * Mapeamento de status da API:
 *   OPERATIONAL         → online
 *   DEGRADEDPERFORMANCE → instável
 *   PARTIALOUTAGE       → instável
 *   UNDERMAINTENANCE    → instável
 *   MAJOROUTAGE         → offline
 */

import axios from "axios";
import { config } from "../../config";
import { getLogger } from "../../logger";
import {
  SourceResult,
  SRC_ONLINE, SRC_UNSTABLE, SRC_OFFLINE, SRC_UNKNOWN,
} from "../types";
import { axiosGetWithRetry, getRandomUserAgent } from "./utils";

const log = getLogger("Webmania");

const STATUS_MAP: Record<string, string> = {
  OPERATIONAL:          SRC_ONLINE,
  DEGRADEDPERFORMANCE:  SRC_UNSTABLE,
  PARTIALOUTAGE:        SRC_UNSTABLE,
  UNDERMAINTENANCE:     SRC_UNSTABLE,
  MAJOROUTAGE:          SRC_OFFLINE,
};

// Expansão de autorizadores regionais
const REGIONAL_LABELS: Record<string, Record<string, string>> = {
  "NFC-e": {
    SVRS: "SVRS (AC, AL, AP, BA, DF, ES, MA, PA, PB, PE, PI, RJ, RN, RO, RR, SE, TO)",
  },
  "NF-e": {
    SVRS: "SVRS (AC, AL, AP, CE, DF, ES, PA, PB, PI, RJ, RN, RO, RR, SC, SE, TO)",
    SVAN: "SVAN (MA)",
  },
};

interface ApiComponent {
  name:             string;
  status:           string;
  group?:           { name: string };
  activeIncidents?: { name: string }[];
}

export async function checkWebmania(
  docType:    string,
  components: readonly string[]
): Promise<SourceResult> {
  const start = Date.now();

  try {
    const res = await axiosGetWithRetry<ApiComponent[]>(config.SEFAZ_API_URL, {
      timeout: config.TIMEOUT_MS,
      headers: { "User-Agent": getRandomUserAgent() },
    });
    const elapsed = Date.now() - start;

    if (res.status !== 200) {
      log.warn(`HTTP ${res.status}`);
      return { sourceName: "Webmania", status: SRC_UNKNOWN, detail: `HTTP ${res.status}`, responseMs: elapsed };
    }

    const raw      = res.data;
    const allComps = Array.isArray(raw) ? raw : (raw as { components?: ApiComponent[] }).components ?? [];

    // Filtra por autorizador + tipo de documento
    const filtered = allComps.filter((c) =>
      components.includes(c.name) &&
      (c.group?.name ?? "").toLowerCase().includes(docType.toLowerCase())
    );

    if (filtered.length === 0) {
      log.warn(`Nenhum componente para ${docType}`);
      return { sourceName: "Webmania", status: SRC_UNKNOWN, detail: "Sem componentes na resposta", responseMs: elapsed };
    }

    const statuses = filtered.map((c) => STATUS_MAP[c.status?.toUpperCase()] ?? SRC_OFFLINE);
    const worst    = statuses.includes(SRC_OFFLINE)  ? SRC_OFFLINE
                   : statuses.includes(SRC_UNSTABLE) ? SRC_UNSTABLE
                   : SRC_ONLINE;

    const problematic = filtered.filter(
      (c) => (STATUS_MAP[c.status?.toUpperCase()] ?? SRC_OFFLINE) !== SRC_ONLINE
    );
    const incidents = filtered.flatMap((c) => (c.activeIncidents ?? []).map((i) => i.name));

    let detail: string;
    if (incidents.length > 0) {
      detail = "Incidente: " + incidents.slice(0, 2).join("; ");
    } else if (problematic.length > 0) {
      detail = "Afetados: " + problematic.slice(0, 3)
        .map((c) => REGIONAL_LABELS[docType]?.[c.name] ?? c.name)
        .join(", ");
    } else {
      detail = `${filtered.length} autorizador(es) OK`;
    }

    const finalStatus = incidents.length > 0 && worst === SRC_ONLINE ? SRC_UNSTABLE : worst;
    log.info(`[${docType}] ${filtered.length} componentes → ${finalStatus.toUpperCase()} | ${elapsed}ms`);
    return { sourceName: "Webmania", status: finalStatus, detail, responseMs: elapsed };

  } catch (err: any) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.message.includes("timeout")) {
      log.warn("Timeout");
      return { sourceName: "Webmania", status: SRC_UNKNOWN, detail: "Timeout", responseMs: null };
    }
    log.warn(`Erro: ${err}`);
    return { sourceName: "Webmania", status: SRC_UNKNOWN, detail: (err.message || String(err)).substring(0, 80), responseMs: elapsed || null };
  }
}