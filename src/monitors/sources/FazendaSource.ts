/**
 * monitors/sources/FazendaSource.ts — Fonte: Portal Nacional NF-e
 *
 * URL única (cobre NF-e e NFC-e — mesmos autorizadores):
 *   https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx
 *
 * Não existe portal federal equivalente para NFC-e isolado.
 * Os autorizadores (AM, SP, SVRS etc.) são os mesmos para ambos os documentos,
 * então usamos sempre o portal NF-e como fonte de confirmação.
 *
 * Estratégia de scraping:
 *   - A página é ASP.NET com tabela HTML renderizada no servidor (sem JS)
 *   - Cada linha = um autorizador; cada célula = um serviço
 *   - Status é indicado por src de imagem: verde.gif / amarelo.gif / vermelho.gif
 *   - Ou por atributos alt/title das imagens
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

const log = getLogger("Fazenda");

// Portal federal único (NF-e) — cobre os mesmos autorizadores do NFC-e
const FAZENDA_URL = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";

// Palavras-chave nos atributos src/alt/title/class das imagens de status
const GREEN_KEYS  = ["verde", "ativo", "ok", "check", "online", "normal", "legverde"];
const YELLOW_KEYS = ["amarelo", "warn", "instavel", "lento", "degraded", "legamarelo"];
const RED_KEYS    = ["vermelho", "nok", "erro", "parado", "offline", "indisponiv", "legvermelho"];

function inferCell(cellHtml: string): string | null {
  const h = cellHtml.toLowerCase();
  // Extrai src, alt, title e class de qualquer elemento na célula
  const tokens = [
    ...(h.match(/src=["']([^"']+)["']/g) ?? []),
    ...(h.match(/alt=["']([^"']+)["']/g) ?? []),
    ...(h.match(/title=["']([^"']+)["']/g) ?? []),
    ...(h.match(/class=["']([^"']+)["']/g) ?? []),
    ...(h.match(/background(?:-color)?:\s*([#\w]+)/g) ?? []),
  ].join(" ");

  if (RED_KEYS.some((k)    => tokens.includes(k))) return SRC_OFFLINE;
  if (YELLOW_KEYS.some((k) => tokens.includes(k))) return SRC_UNSTABLE;
  if (GREEN_KEYS.some((k)  => tokens.includes(k))) return SRC_ONLINE;

  // Fallback por cor hex inline
  if (tokens.includes("#00b") || tokens.includes("green"))  return SRC_ONLINE;
  if (tokens.includes("#ff0") || tokens.includes("yellow")) return SRC_UNSTABLE;
  if (tokens.includes("#f00") || tokens.includes("red"))    return SRC_OFFLINE;

  return null;
}

export async function checkFazenda(
  docType:    string,
  components: readonly string[]
): Promise<SourceResult> {
  const start = Date.now();

  try {
    const headers = {
      "User-Agent":      getRandomUserAgent(),
      "Accept":          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Cache-Control":   "no-cache",
      "Pragma":          "no-cache",
    };

    // Etapa 1: Chamada inicial impedindo redirecionamento automático para capturar cookies do ASP.NET
    let res = await axiosGetWithRetry<string>(FAZENDA_URL, {
      timeout:        config.TIMEOUT_MS,
      maxRedirects:   0,
      responseType:   "text",
      headers,
      validateStatus: (s) => s >= 200 && s < 400,
    }, 1, 1000); // 1 retentativa interna

    // Se fomos redirecionados (comum no portal SEFAZ ASP.NET para testar suporte a cookies)
    if (res.status === 302) {
      const setCookie = res.headers["set-cookie"];
      const location = res.headers["location"];
      if (!location) {
        throw new Error("Redirecionamento 302 recebido porém sem cabeçalho Location.");
      }

      const redirectUrl = location.startsWith("http")
        ? location
        : new URL(FAZENDA_URL).origin + location;

      const cookies: string[] = [];
      if (setCookie) {
        setCookie.forEach((c) => {
          cookies.push(c.split(";")[0]);
        });
      }

      const step2Headers = { ...headers } as Record<string, string>;
      if (cookies.length > 0) {
        step2Headers["Cookie"] = cookies.join("; ");
      }

      // Etapa 2: Acessa o link de redirecionamento enviando o cookie capturado
      res = await axiosGetWithRetry<string>(redirectUrl, {
        timeout:        config.TIMEOUT_MS,
        maxRedirects:   5,
        responseType:   "text",
        headers:        step2Headers,
        validateStatus: (s) => s < 400,
      }, 1, 1000); // 1 retentativa interna
    }

    const elapsed = Date.now() - start;

    if (res.status !== 200) {
      log.warn(`HTTP ${res.status} após ${elapsed}ms`);
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: `HTTP ${res.status}`, responseMs: elapsed };
    }

    const $ = cheerio.load(res.data);

    // Encontra a tabela que contém "Autorizador" no cabeçalho
    let targetTable = $("table").filter((_, el) =>
      $(el).find("th, td").first().text().toLowerCase().includes("autorizador")
    ).first();

    if (!targetTable.length) {
      // Fallback: qualquer tabela grande com >3 colunas
      targetTable = $("table").filter((_, el) => $(el).find("th").length >= 3).first();
    }

    if (!targetTable.length) {
      log.warn("Tabela não encontrada — HTML pode ter mudado");
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: "Tabela não localizada na página", responseMs: elapsed };
    }

    const rowStatuses = new Map<string, string>();

    targetTable.find("tr").each((_, row) => {
      const cells    = $(row).find("td");
      if (cells.length < 2) return;

      const firstName = $(cells.get(0)).text().trim().toUpperCase();
      const matched   = components.find((c) => firstName.startsWith(c));
      if (!matched) return;

      let worst = SRC_ONLINE;
      cells.each((idx, cell) => {
        if (idx === 0) return;
        const s = inferCell($(cell).html() ?? "");
        if (s === SRC_OFFLINE)                         worst = SRC_OFFLINE;
        else if (s === SRC_UNSTABLE && worst !== SRC_OFFLINE) worst = SRC_UNSTABLE;
      });

      rowStatuses.set(matched, worst);
    });

    if (rowStatuses.size === 0) {
      log.warn(`Nenhum dos autorizadores [${components.join(",")}] encontrado na tabela`);
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: "Autorizadores não encontrados na tabela", responseMs: elapsed };
    }

    const all    = Array.from(rowStatuses.values());
    const final  = all.includes(SRC_OFFLINE) ? SRC_OFFLINE : all.includes(SRC_UNSTABLE) ? SRC_UNSTABLE : SRC_ONLINE;
    const bad    = Array.from(rowStatuses.entries()).filter(([, s]) => s !== SRC_ONLINE).map(([n, s]) => `${n}(${s})`).slice(0, 4);
    const detail = bad.length > 0 ? `Afetados: ${bad.join(", ")}` : `${rowStatuses.size} autorizador(es) OK`;

    log.info(`[${docType}] ${rowStatuses.size} autorizadores → ${final.toUpperCase()} | ${elapsed}ms`);
    return { sourceName: "Fazenda Nacional", status: final, detail, responseMs: elapsed };

  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("ECONNABORTED") || msg.includes("timeout")) {
      log.warn("Timeout");
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: "Timeout ao acessar portal", responseMs: null };
    }
    if (msg.includes("ENOTFOUND")) {
      log.warn(`DNS não resolvido: ${msg}`);
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: "Sem DNS — portal inacessível", responseMs: null };
    }
    if (msg.includes("TOO_MANY_REDIRECTS")) {
      log.warn("Loop de redirect — ignorando fonte");
      return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: "Redirect loop no portal", responseMs: elapsed };
    }

    log.warn(`Erro: ${msg}`);
    return { sourceName: "Fazenda Nacional", status: SRC_UNKNOWN, detail: msg.substring(0, 80), responseMs: elapsed || null };
  }
}