/**
 * monitors/sources/NfeioSource.ts — Fonte: NFe.io Status API
 *
 * API pública gratuita do NFe.io (grande provedor NF-e brasileiro).
 *
 * Endpoints:
 *   - Componentes: GET https://status.nfe.io/api/v1/components
 *   - Incidentes:  GET https://status.nfe.io/api/v1/notices?per_page=5
 *
 * IDs dos componentes SEFAZ:
 *   - NF-e:  2509 ("Processamento de NF-e (SEFAZ)")
 *   - NFC-e: 10050 ("Processamento de NFC-e (SEFAZ)")
 *
 * Mapeamento de status:
 *   operational          → online
 *   degraded_performance → instável
 *   partial_outage       → instável
 *   major_outage         → offline
 */

import { getLogger } from "../../logger";
import {
  SourceResult,
  SRC_ONLINE, SRC_UNSTABLE, SRC_OFFLINE, SRC_UNKNOWN,
} from "../types";
import { axiosGetWithRetry, getRandomUserAgent } from "./utils";

const log = getLogger("NFe.io");

const COMPONENTS_URL = "https://status.nfe.io/api/v1/components";
const NOTICES_URL = "https://status.nfe.io/api/v1/notices?per_page=5";

// IDs dos componentes SEFAZ no NFe.io
const COMPONENT_IDS: Record<string, number> = {
  "NF-e": 2509,
  "NFC-e": 10050,
};

const STATE_MAP: Record<string, string> = {
  operational: SRC_ONLINE,
  degraded_performance: SRC_UNSTABLE,
  partial_outage: SRC_UNSTABLE,
  major_outage: SRC_OFFLINE,
  under_maintenance: SRC_UNSTABLE,
};

interface NfeioComponent {
  id: number;
  name: string;
  state: string;
}

interface NfeioNotice {
  id: number;
  subject: string;
  state: string;       // "investigating" | "identified" | "recovering" | "resolved"
  began_at: string;
  ended_at: string | null;
}

export async function checkNfeio(
  docType: string,
  _components: readonly string[]
): Promise<SourceResult> {
  const start = Date.now();
  const targetId = COMPONENT_IDS[docType];

  if (!targetId) {
    return {
      sourceName: "NFe.io",
      status: SRC_UNKNOWN,
      detail: `Tipo de documento não mapeado: ${docType}`,
      responseMs: null,
    };
  }

  try {
    // 1. Busca status dos componentes
    const compRes = await axiosGetWithRetry<{ components: NfeioComponent[] }>(COMPONENTS_URL, {
      timeout: 10000,
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin"
      },
    });

    const elapsed = Date.now() - start;

    if (compRes.status !== 200) {
      log.warn(`HTTP ${compRes.status}`);
      return { sourceName: "NFe.io", status: SRC_UNKNOWN, detail: `HTTP ${compRes.status}`, responseMs: elapsed };
    }

    const components = compRes.data?.components ?? [];
    const target = components.find((c) => c.id === targetId);

    if (!target) {
      log.warn(`Componente ${docType} (id ${targetId}) não encontrado`);
      return { sourceName: "NFe.io", status: SRC_UNKNOWN, detail: "Componente não encontrado", responseMs: elapsed };
    }

    const componentStatus = STATE_MAP[target.state] ?? SRC_UNKNOWN;

    // 2. Busca incidentes ativos
    let activeIncidents: string[] = [];
    try {
      const noticesRes = await axiosGetWithRetry<{ notices: NfeioNotice[] }>(NOTICES_URL, {
        timeout: 8000,
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin"
        },
      });

      if (noticesRes.status === 200 && noticesRes.data?.notices) {
        const sefazKeywords = ["sefaz", "nf-e", "nfc-e", "nfe", "nfce", "autorizador"];
        activeIncidents = noticesRes.data.notices
          .filter((n) => {
            if (n.state === "resolved") return false;
            const subject = n.subject.toLowerCase();
            return sefazKeywords.some((kw) => subject.includes(kw));
          })
          .map((n) => n.subject)
          .slice(0, 2);
      }
    } catch {
      // Ignora falha na busca de incidentes — não é crítica
    }

    // 3. Determina status final
    let finalStatus: typeof SRC_ONLINE | typeof SRC_UNSTABLE | typeof SRC_OFFLINE | typeof SRC_UNKNOWN = componentStatus as any;
    let detail: string;

    if (activeIncidents.length > 0) {
      // Se há incidentes SEFAZ ativos, eleva para instável no mínimo
      if (finalStatus === SRC_ONLINE) finalStatus = SRC_UNSTABLE;
      detail = `Incidente: ${activeIncidents.join("; ")}`;
    } else if (finalStatus === SRC_ONLINE) {
      detail = `${docType} operacional`;
    } else {
      detail = `${docType}: ${target.state}`;
    }

    log.info(`[${docType}] ${finalStatus.toUpperCase()} | ${elapsed}ms`);
    return { sourceName: "NFe.io", status: finalStatus, detail, responseMs: elapsed };

  } catch (err: any) {
    const elapsed = Date.now() - start;
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.message?.includes("timeout")) {
      log.warn("Timeout");
      return { sourceName: "NFe.io", status: SRC_UNKNOWN, detail: "Timeout", responseMs: null };
    }
    log.warn(`Erro: ${err.message}`);
    return { sourceName: "NFe.io", status: SRC_UNKNOWN, detail: (err.message || String(err)).substring(0, 80), responseMs: elapsed || null };
  }
}
