/**
 * monitors/sources/ZorteSource.ts — Fonte: monitor.zorte.com.br
 *
 * O Zorte é uma aplicação Next.js. Estratégia de extração em 3 camadas:
 *
 * 1. __NEXT_DATA__ (JSON embutido no HTML) — mais confiável
 * 2. Busca por padrões data-* e aria-label no HTML — fallback estruturado
 * 3. Busca por texto próximo a siglas de autorizadores — último recurso
 *
 * URLs:
 *   NF-e : https://monitor.zorte.com.br/nfe
 *   NFC-e: https://monitor.zorte.com.br/nfce
 *
 * Status mapeados:
 *   Normal / Operando      → online
 *   Instável / Lentidão / Contingência → instável
 *   Parada / Indisponível  → offline
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { config } from "../../config";
import { getLogger } from "../../logger";
import {
  SourceResult,
  SRC_ONLINE, SRC_UNSTABLE, SRC_OFFLINE, SRC_UNKNOWN,
} from "../types";
import { axiosGetWithRetry, getRandomUserAgent } from "./utils";

const log = getLogger("Zorte");

const ZORTE_URLS: Record<string, string> = {
  "NF-e":  "https://monitor.zorte.com.br/nfe",
  "NFC-e": "https://monitor.zorte.com.br/nfce",
};

// Normaliza string removendo acentos e lowercaseando
function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function mapStatus(text: string): string {
  const n = norm(text);
  if (n.includes("parada") || n.includes("indisponiv") || n.includes("offline")) return SRC_OFFLINE;
  if (n.includes("instav") || n.includes("lentidao") || n.includes("lentidão") ||
      n.includes("contingencia") || n.includes("manutencao")) return SRC_UNSTABLE;
  if (n.includes("normal") || n.includes("operando") || n.includes("online") ||
      n.includes("ok")) return SRC_ONLINE;
  return SRC_UNKNOWN;
}

/**
 * Tenta extrair dados do bloco __NEXT_DATA__ (Next.js).
 * Percorre recursivamente a árvore de props buscando array com campo "status" e nome de UF.
 */
function fromNextData(html: string, components: readonly string[]): Map<string, string> | null {
  try {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;

    const root = JSON.parse(match[1]);

    // Busca recursiva por arrays que parecem listas de estados
    function findList(obj: unknown, depth = 0): unknown[] | null {
      if (depth > 8 || obj == null || typeof obj !== "object") return null;
      if (Array.isArray(obj) && obj.length > 0) {
        const sample = obj[0];
        if (sample && typeof sample === "object") {
          const keys = Object.keys(sample as object).map((k) => k.toLowerCase());
          // Verifica se parece uma lista de estados SEFAZ
          if (
            keys.some((k) => ["uf", "estado", "autorizador", "sigla", "name"].includes(k)) &&
            keys.some((k) => ["status", "situacao", "state"].includes(k))
          ) {
            return obj;
          }
        }
      }
      for (const v of Object.values(obj as Record<string, unknown>)) {
        const found = findList(v, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const list = findList(root);
    if (!list) return null;

    const result = new Map<string, string>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      // Tenta diferentes campos para o nome do autorizador
      const name = String(
        obj.uf ?? obj.sigla ?? obj.autorizador ?? obj.estado ?? obj.name ?? obj.codigo ?? ""
      ).toUpperCase().trim();

      // Tenta diferentes campos para o status
      const statusRaw = String(
        obj.status ?? obj.situacao ?? obj.state ?? obj.descricao ?? ""
      );

      if (!name || !statusRaw) continue;

      const matched = components.find((c) => name.startsWith(c) || name === c);
      if (!matched) continue;

      const s = mapStatus(statusRaw);
      if (s !== SRC_UNKNOWN) result.set(matched, s);
    }

    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Fallback: busca por elementos HTML que contenham sigla + status próximos.
 * Usa cheerio para navegar pela árvore DOM.
 */
function fromHtml(html: string, components: readonly string[]): Map<string, string> {
  const $      = cheerio.load(html);
  const result = new Map<string, string>();

  // Busca em elementos comuns de lista/tabela
  $("tr, li, div, article, section").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 300) return;

    const upper = text.toUpperCase();
    const matched = components.find((c) => {
      // Verifica se a sigla aparece como palavra isolada
      const re = new RegExp(`\\b${c}\\b`);
      return re.test(upper);
    });
    if (!matched) return;

    const s = mapStatus(text);
    if (s !== SRC_UNKNOWN && !result.has(matched)) {
      result.set(matched, s);
    }
  });

  // Segunda passagem: busca por data-* e aria-label
  $("[data-status],[data-situacao],[aria-label]").each((_, el) => {
    const statusAttr = $(el).attr("data-status") ?? $(el).attr("data-situacao") ?? $(el).attr("aria-label") ?? "";
    const nameAttr   = $(el).attr("data-uf") ?? $(el).attr("data-estado") ?? $(el).attr("data-name") ?? $(el).text();

    if (!statusAttr || !nameAttr) return;
    const upper   = nameAttr.toUpperCase().trim();
    const matched = components.find((c) => upper.startsWith(c) || upper === c);
    if (!matched) return;

    const s = mapStatus(statusAttr);
    if (s !== SRC_UNKNOWN) result.set(matched, s);
  });

  return result;
}

/**
 * Camada 1: Extrai dados analisando as classes do SVG do mapa do Zorte.
 * Mapeia grupos <g> com classes de status para as UFs filhas <a> com id="state_uf".
 */
function fromSvg(html: string, components: readonly string[]): Map<string, string> | null {
  try {
    const $ = cheerio.load(html);
    const result = new Map<string, string>();

    $("svg g").each((_, g) => {
      const gClass = $(g).attr("class") || "";
      let status = SRC_UNKNOWN;

      if (gClass.includes("model-green")) {
        status = SRC_ONLINE;
      } else if (gClass.includes("model-yellow") || gClass.includes("model-orange")) {
        status = SRC_UNSTABLE;
      } else if (gClass.includes("model-red")) {
        status = SRC_OFFLINE;
      }

      if (status === SRC_UNKNOWN) return;

      $(g).find("a.state").each((_, a) => {
        const id = $(a).attr("id") || "";
        const uf = id.replace("state_", "").toUpperCase().trim();
        if (!uf) return;

        const matched = components.find((c) => uf === c);
        if (matched) {
          result.set(matched, status);
        }
      });
    });

    return result.size > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function checkZorte(
  docType:    string,
  components: readonly string[]
): Promise<SourceResult> {
  const url   = ZORTE_URLS[docType];
  const start = Date.now();

  if (!url) {
    return { sourceName: "Zorte", status: SRC_UNKNOWN, detail: `Sem URL para ${docType}`, responseMs: null };
  }

  try {
    const res = await axiosGetWithRetry<string>(url, {
      timeout:      config.TIMEOUT_MS,
      maxRedirects: 5,
      responseType: "text",
      headers: {
        "User-Agent":      getRandomUserAgent(),
        "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      validateStatus: (s) => s < 400,
    });
    const elapsed = Date.now() - start;

    if (res.status !== 200) {
      log.warn(`HTTP ${res.status}`);
      return { sourceName: "Zorte", status: SRC_UNKNOWN, detail: `HTTP ${res.status}`, responseMs: elapsed };
    }

    const html = res.data as string;

    // Camada 1: SVG parsing (mais confiável para Next.js App Router)
    let statuses = fromSvg(html, components);
    let method   = "SVG parsing";

    // Camada 2: __NEXT_DATA__
    if (!statuses || statuses.size === 0) {
      statuses = fromNextData(html, components);
      method   = "__NEXT_DATA__";
    }

    // Camada 3: HTML scraping
    if (!statuses || statuses.size === 0) {
      statuses = fromHtml(html, components);
      method   = "HTML scraping";
    }

    // Filtra apenas status reconhecidos
    const known = statuses
      ? new Map(Array.from(statuses.entries()).filter(([, s]) => s !== SRC_UNKNOWN))
      : new Map<string, string>();

    if (known.size === 0) {
      // Diagnóstico: mostra o tamanho do HTML para ajudar debug
      const hasNextData = html.includes("__NEXT_DATA__");
      log.warn(
        `Dados não extraídos. HTML: ${html.length} chars | ` +
        `tem __NEXT_DATA__: ${hasNextData} | método tentado: ${method}`
      );
      return { sourceName: "Zorte", status: SRC_UNKNOWN, detail: "Estrutura do site mudou ou conteúdo via JS", responseMs: elapsed };
    }

    const all    = Array.from(known.values());
    const final  = all.includes(SRC_OFFLINE) ? SRC_OFFLINE : all.includes(SRC_UNSTABLE) ? SRC_UNSTABLE : SRC_ONLINE;
    const bad    = Array.from(known.entries()).filter(([, s]) => s !== SRC_ONLINE).map(([n, s]) => `${n}(${s})`).slice(0, 4);
    const detail = bad.length > 0 ? `Afetados: ${bad.join(", ")}` : `${known.size} autorizador(es) OK`;

    log.info(`[${docType}] via ${method} | ${known.size} encontrados → ${final.toUpperCase()} | ${elapsed}ms`);
    return { sourceName: "Zorte", status: final, detail, responseMs: elapsed };

  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("ECONNABORTED") || msg.includes("timeout")) {
      log.warn("Timeout");
      return { sourceName: "Zorte", status: SRC_UNKNOWN, detail: "Timeout", responseMs: null };
    }
    log.warn(`Erro: ${msg}`);
    return { sourceName: "Zorte", status: SRC_UNKNOWN, detail: msg.substring(0, 80), responseMs: elapsed || null };
  }
}