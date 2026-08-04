/**
 * config.ts — Configurações centrais do Bot PDV SEFAZ
 *
 * Variáveis sensíveis (token, canal) são lidas do arquivo .env.
 * Copie .env.example para .env e preencha antes de rodar o bot.
 */

import dotenv from "dotenv";
dotenv.config();

export const config = {
  // ── Discord (lidos do .env) ────────────────────────────────────────────────
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
  CHANNEL_ID: process.env.CHANNEL_ID ?? "",

  // ── Certificado Digital A1 (lidos do .env) ──────────────────────────────────
  CERT_PATH: process.env.CERT_PATH ?? "",
  CERT_PASSWORD: process.env.CERT_PASSWORD ?? "",

  // ── Fuso horário ───────────────────────────────────────────────────────────
  TIMEZONE_OFFSET: -3, // Brasília UTC-3

  // ── Monitoramento geral ────────────────────────────────────────────────────
  CHECK_INTERVAL_MS: 60_000,           // 60 segundos em ms
  TIMEOUT_MS: 30_000,                  // 30 segundos em ms
  SLOW_THRESHOLD_MS: 15_000,           // acima disto → resposta lenta (Muito Lento)
  UNSTABLE_CONSECUTIVE_CHECKS: 3,      // checks consecutivos para confirmar mudança

  // ── Alertas e Menções ────────────────────────────────────────────────────
  // IDs dos cargos do Discord para menções em alertas.
  // Quando preenchidos, substituem @everyone. Se todos vazios, usa @everyone.
  // Para obter IDs: Discord → Configurações → Avançado → Modo Desenvolvedor → Copiar ID do Cargo.
  ROLE_SUPORTE:        process.env.ROLE_SUPORTE ?? "",
  ROLE_RELACIONAMENTO: process.env.ROLE_RELACIONAMENTO ?? "",
  ROLE_IMPLANTACAO:    process.env.ROLE_IMPLANTACAO ?? "",
  ROLE_MARKETING:      process.env.ROLE_MARKETING ?? "",

  // ── Horário Silencioso (sem menções) ────────────────────────────────────
  QUIET_HOUR_START: 22,                // 22:00 Brasília — início do silêncio
  QUIET_HOUR_END: 8,                   // 08:00 Brasília — fim do silêncio

  // ── Monitor Eveo ──────────────────────────────────────────────────────────
  // API pública do Status.io (plataforma da Eveo). Sem autenticação.
  EVEO_API_URL:
    "https://api.status.io/1.0/status/66d5ff1580a4e633c1aec154",

  // Substrings para filtrar data centers monitorados (vazio = todos os 26)
  //   "SP1" → Data center SP1 (Cotia)
  //   "SP2" → Data center SP2 (Osasco)
  EVEO_FILTER_DATACENTERS: ["SP", "RJ"] as string[],

  // ── Monitor SEFAZ (via API pública Webmania) ───────────────────────────────
  SEFAZ_API_URL:"https://monitorsefaz.webmaniabr.com/v2/components.json",
  SEFAZ_SUMMARY_URL:"https://monitorsefaz.webmaniabr.com/summary.json",

  // Autorizadores NFC-e
  SEFAZ_NFCE_COMPONENTS: [
    "AM", "CE", "GO", "MG", "MS", "MT", "PR", "RS", "SP", "SVRS",
  ],

  // Autorizadores NF-e
  SEFAZ_NFE_COMPONENTS: [
    "AM", "BA", "GO", "MG", "MS", "MT", "PE", "PR", "RS", "SP", "SVAN", "SVRS",
  ],

  // Lista de User-Agents para rotatividade
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
  ],
} as const;