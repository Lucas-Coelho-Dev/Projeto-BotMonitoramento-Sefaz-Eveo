import fs from "fs";
import https from "https";
import axios from "axios";
import * as cheerio from "cheerio";
import { config } from "../../config";
import { getLogger } from "../../logger";
import {
  SourceResult,
  SourceStatus,
  SRC_ONLINE, SRC_UNSTABLE, SRC_OFFLINE, SRC_UNKNOWN,
} from "../types";
import { axiosGetWithRetry, getRandomUserAgent } from "./utils";

const log = getLogger("DirectPing");

// Mapeamento dos servidores WSDL estaduais da SEFAZ para NF-e e NFC-e
const DIRECT_URLS: Record<string, { "NF-e": string; "NFC-e": string }> = {
  SP: {
    "NF-e": "https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx?wsdl",
    "NFC-e": "https://nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx?wsdl"
  },
  RS: {
    "NF-e": "https://nfe.svrs.rs.gov.br/ws/NFeStatusServico4/NFeStatusServico4.asmx?wsdl",
    "NFC-e": "https://nfce.svrs.rs.gov.br/ws/NFeStatusServico4/NFeStatusServico4.asmx?wsdl"
  },
  SVRS: {
    "NF-e": "https://nfe.svrs.rs.gov.br/ws/NFeStatusServico4/NFeStatusServico4.asmx?wsdl",
    "NFC-e": "https://nfce.svrs.rs.gov.br/ws/NFeStatusServico4/NFeStatusServico4.asmx?wsdl"
  },
  GO: {
    "NF-e": "https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4?wsdl"
  },
  MG: {
    "NF-e": "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfce.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4?wsdl"
  },
  PR: {
    "NF-e": "https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfce.sefa.pr.gov.br/nfce/NFeStatusServico4?wsdl"
  },
  BA: {
    "NF-e": "https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx?wsdl",
    "NFC-e": "https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx?wsdl"
  },
  AM: {
    "NF-e": "https://nfe.sefaz.am.gov.br/services-nfe/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfce.sefaz.am.gov.br/services-nfe/services/NFeStatusServico4?wsdl"
  },
  CE: {
    "NF-e": "https://nfe.sefaz.ce.gov.br/nfe4/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfe.sefaz.ce.gov.br/nfe4/services/NFeStatusServico4?wsdl"
  },
  PE: {
    "NF-e": "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4?wsdl"
  },
  MS: {
    "NF-e": "https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfce.sefaz.ms.gov.br/ws/NFeStatusServico4?wsdl"
  },
  MT: {
    "NF-e": "https://nfe.sefaz.mt.gov.br/nfews/v4/services/NFeStatusServico4?wsdl",
    "NFC-e": "https://nfce.sefaz.mt.gov.br/nfews/v4/services/NFeStatusServico4?wsdl"
  }
};

// Códigos IBGE de cada UF para consulta SOAP consStatServ
const UF_IBGE_CODES: Record<string, string> = {
  SP: "35",
  RS: "43",
  SVRS: "43",
  GO: "52",
  MG: "31",
  PR: "41",
  BA: "29",
  AM: "13",
  CE: "23",
  PE: "26",
  MS: "50",
  MT: "51"
};

// SOAP Action correspondente para NF-e Status Serviço v4.00
const SOAP_ACTION = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF";

export async function checkDirectPing(
  docType:    string,
  components: readonly string[]
): Promise<SourceResult> {
  const start = Date.now();
  const results = new Map<string, string>();
  const promises: Promise<void>[] = [];

  // Filtra apenas os autorizadores passados que temos uma URL mapeada
  const activeComponents = components.filter(c => c in DIRECT_URLS);

  if (activeComponents.length === 0) {
    return {
      sourceName: "Ping Direto",
      status:     SRC_UNKNOWN,
      detail:     "Nenhum servidor mapeado neste ciclo",
      responseMs: null
    };
  }

  // Verifica se o certificado está configurado e existe
  let hasCert = false;
  let httpsAgent: https.Agent | null = null;

  if (config.CERT_PATH) {
    try {
      if (fs.existsSync(config.CERT_PATH)) {
        const pfx = fs.readFileSync(config.CERT_PATH);
        httpsAgent = new https.Agent({
          pfx,
          passphrase: config.CERT_PASSWORD,
          rejectUnauthorized: false
        });
        hasCert = true;
      } else {
        log.warn(`Certificado configurado mas arquivo não encontrado em: ${config.CERT_PATH}`);
      }
    } catch (err: any) {
      log.error(`Erro ao carregar certificado digital (${config.CERT_PATH}): ${err.message}`);
    }
  }

  for (const component of activeComponents) {
    const urls = DIRECT_URLS[component];
    const url = urls ? urls[docType as "NF-e" | "NFC-e"] : null;

    if (!url) continue;

    promises.push(
      (async () => {
        // Remove "?wsdl" para obter o endpoint SOAP do serviço
        const soapUrl = url.replace(/\?(wsdl|WSDL)$/i, "");
        const cUF = UF_IBGE_CODES[component] || "35";

        if (hasCert && httpsAgent) {
          try {
            // Monta o payload XML minificado (obrigatório para evitar erro 588)
            const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4"><consStatServ versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ></nfeDadosMsg></soap12:Body></soap12:Envelope>`;

            // Envia SOAP POST com retry manual
            let response = null;
            let retries = 2;
            let delayMs = 1000;
            const startTime = Date.now();

            while (retries >= 0) {
              try {
                response = await axios.post(soapUrl, soapEnvelope, {
                  headers: {
                    "Content-Type": "application/soap+xml; charset=utf-8",
                    "SOAPAction": SOAP_ACTION,
                    "User-Agent": getRandomUserAgent()
                  },
                  httpsAgent,
                  timeout: 30000 // 30s timeout
                });
                break;
              } catch (err: any) {
                const isTimeout = err.code === "ECONNABORTED" || err.message.includes("timeout");
                if (isTimeout) {
                  throw err; // Timeout de 30s -> falha imediatamente, não tenta de novo
                }
                const isRetryable =
                  retries > 0 &&
                  (err.code === "ECONNRESET" ||
                   err.code === "EPROTO" ||
                   (err.response && err.response.status >= 500));

                if (isRetryable) {
                  retries--;
                  await new Promise((resolve) => setTimeout(resolve, delayMs));
                  delayMs *= 2;
                } else {
                  throw err;
                }
              }
            }

            const elapsed = Date.now() - startTime;

            if (response && response.data) {
              const $ = cheerio.load(response.data, { xmlMode: true });
              const cStat = $("cStat").text().trim();
              const xMotivo = $("xMotivo").text().trim();

              if (cStat === "107") {
                if (elapsed > 15000) {
                  results.set(component, SRC_UNSTABLE);
                  log.info(`SEFAZ ${component} respondeu via SOAP mas com latência alta: ${elapsed}ms (Muito Lento)`);
                } else {
                  results.set(component, SRC_ONLINE);
                }
              } else {
                results.set(component, SRC_OFFLINE);
                log.warn(`SEFAZ ${component} retornou cStat ${cStat} (${xMotivo || "Sem motivo"})`);
              }
            } else {
              throw new Error("Resposta SOAP vazia ou inválida");
            }
          } catch (soapErr: any) {
            log.debug(`Chamada SOAP para ${component} (${soapUrl}) falhou: ${soapErr.message}. Executando fallback HTTPS GET...`);
            await runGetPingFallback(url, component, results, soapErr.message);
          }
        } else {
          await runGetPingFallback(url, component, results);
        }
      })()
    );
  }

  await Promise.all(promises);
  const elapsed = Date.now() - start;

  const allStatuses = Array.from(results.values());

  if (allStatuses.length === 0) {
    return {
      sourceName: "Ping Direto",
      status:     SRC_UNKNOWN,
      detail:     "Falha ao realizar ping em todos os servidores",
      responseMs: elapsed
    };
  }

  // Consolidação ponderada local: Se algum estado estiver offline -> offline. 
  // Se nenhum estiver offline, mas algum estiver instável (muito lento) -> instável.
  let finalStatus: SourceStatus = SRC_ONLINE;
  if (allStatuses.includes(SRC_OFFLINE)) {
    finalStatus = SRC_OFFLINE;
  } else if (allStatuses.includes(SRC_UNSTABLE)) {
    finalStatus = SRC_UNSTABLE;
  }

  const offlineStates = Array.from(results.entries())
    .filter(([, s]) => s === SRC_OFFLINE)
    .map(([n]) => n);

  const unstableStates = Array.from(results.entries())
    .filter(([, s]) => s === SRC_UNSTABLE)
    .map(([n]) => n);

  let detail = "";
  if (offlineStates.length > 0) {
    detail += `Caídos: ${offlineStates.join(", ")}`;
  }
  if (unstableStates.length > 0) {
    if (detail) detail += " | ";
    detail += `Lentos (>15s): ${unstableStates.join(", ")}`;
  }
  if (!detail) {
    detail = `${results.size} servidor(es) normais`;
  }

  return {
    sourceName: "Ping Direto",
    status:     finalStatus,
    detail,
    responseMs: elapsed
  };
}

// Lógica de fallback original (HTTPS GET para WSDL) com contagem de latência
async function runGetPingFallback(
  url: string,
  component: string,
  results: Map<string, string>,
  soapErrorMsg?: string
): Promise<void> {
  const startTime = Date.now();
  try {
    await axiosGetWithRetry(url, {
      timeout: 30000, // timeout de 30s
      maxRedirects: 2,
      headers: {
        "User-Agent": getRandomUserAgent()
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true
    }, 2, 1000);

    const elapsed = Date.now() - startTime;
    if (elapsed > 15000) {
      results.set(component, SRC_UNSTABLE);
      log.info(`SEFAZ ${component} respondeu via Fallback GET mas com latência alta: ${elapsed}ms (Muito Lento)`);
    } else {
      results.set(component, SRC_ONLINE);
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime;

    const isSslRelated =
      err.code === "ECONNRESET" ||
      err.code === "EPROTO" ||
      (err.message && err.message.toLowerCase().includes("certificate"));

    // ── Distinção entre rejeição TLS legítima vs queda real ──────────────
    // Se o erro foi RÁPIDO (< 3 segundos) e é SSL-related, provavelmente o
    // servidor está VIVO mas rejeitou nosso handshake TLS (comportamento normal
    // da SEFAZ sem certificado mTLS no GET). → ONLINE
    //
    // Se o erro DEMOROU (>= 3 segundos), significa que o servidor travou ou
    // está fora do ar — o reset/proto veio APÓS tentativa prolongada. → OFFLINE
    const FAST_REJECTION_MS = 3000;

    if (isSslRelated && elapsed < FAST_REJECTION_MS) {
      // Rejeição TLS rápida = servidor respondendo, está vivo
      results.set(component, SRC_ONLINE);
    } else if (isSslRelated && elapsed >= FAST_REJECTION_MS && elapsed <= 15000) {
      // Reset/proto entre 3s e 15s = servidor com problemas
      results.set(component, SRC_UNSTABLE);
      log.warn(
        `SEFAZ ${component} retornou ${err.code} após ${elapsed}ms (servidor com problemas). ` +
        `SOAP: ${soapErrorMsg || "N/A"}`
      );
    } else {
      // Timeout, ECONNREFUSED, ou SSL lento (>15s) = servidor caído
      results.set(component, SRC_OFFLINE);
      log.warn(
        `Ping Direto falhou para ${component} (${url}). ` +
        `Erro: ${err.code || err.message} em ${elapsed}ms | ` +
        `SOAP: ${soapErrorMsg || "N/A"}`
      );
    }
  }
}
