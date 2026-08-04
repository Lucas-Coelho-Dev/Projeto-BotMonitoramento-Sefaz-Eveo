/**
 * monitors/sources/types.ts — Tipos compartilhados entre as fontes de dados SEFAZ
 */

/** Status possíveis retornados por cada fonte */
export const SRC_ONLINE   = "online";
export const SRC_UNSTABLE = "instável";
export const SRC_OFFLINE  = "offline";
export const SRC_UNKNOWN  = "indeterminado"; // fonte inacessível — não conta no consenso

export type SourceStatus = typeof SRC_ONLINE | typeof SRC_UNSTABLE | typeof SRC_OFFLINE | typeof SRC_UNKNOWN;

/** Resultado de uma fonte individual */
export interface SourceResult {
  sourceName: string;     // "Webmania" | "Fazenda Nacional" | "Zorte"
  status:     SourceStatus;
  detail:     string;     // detalhe textual do resultado
  responseMs: number | null;
}

/**
 * Determina o status final por CONSENSO entre múltiplas fontes.
 *
 * Regras:
 *   - Fontes com status INDETERMINADO (inacessíveis) são ignoradas no voto
 *   - Se nenhuma fonte está disponível → retorna INDETERMINADO
 *   - Se maioria (>=50%) das fontes disponíveis vota OFFLINE → OFFLINE
 *   - Se maioria (>=50%) vota ONLINE → ONLINE
 *   - Qualquer discordância → INSTÁVEL (cauteloso)
 *
 * Exemplos com 3 fontes:
 *   ONLINE  + ONLINE  + ONLINE   → ONLINE
 *   OFFLINE + OFFLINE + ONLINE   → OFFLINE (2 de 3)
 *   ONLINE  + OFFLINE + ONLINE   → INSTÁVEL (discordância)
 *   OFFLINE + INDETER + OFFLINE  → OFFLINE (2 de 2 disponíveis)
 *   INDETER + INDETER + INDETER  → INDETERMINADO (todas offline)
 */
const SOURCE_WEIGHTS: Record<string, number> = {
  "Ping Direto": 4.0,
  "Fazenda Nacional": 2.0,
  "Webmania": 1.0,
};

export function resolveConsensus(results: SourceResult[]): {
  finalStatus: SourceStatus;
  detail:      string;
} {
  const available = results.filter((r) => r.status !== SRC_UNKNOWN);

  if (available.length === 0) {
    const names = results.map((r) => r.sourceName).join(", ");
    return {
      finalStatus: SRC_UNKNOWN,
      detail: `Todas as fontes indisponíveis (${names}) — aguardando próximo ciclo`,
    };
  }

  let totalWeight = 0;
  let onlineWeight = 0;
  let offlineWeight = 0;
  let unstableWeight = 0;

  for (const r of available) {
    const weight = SOURCE_WEIGHTS[r.sourceName] ?? 1.0;
    totalWeight += weight;
    if (r.status === SRC_ONLINE) onlineWeight += weight;
    else if (r.status === SRC_OFFLINE) offlineWeight += weight;
    else if (r.status === SRC_UNSTABLE) unstableWeight += weight;
  }

  let finalStatus: SourceStatus;
  if (onlineWeight > totalWeight / 2) {
    finalStatus = SRC_ONLINE;
  } else if (offlineWeight > totalWeight / 2) {
    finalStatus = SRC_OFFLINE;
  } else {
    finalStatus = SRC_UNSTABLE;
  }

  // Monta detalhe com votos de cada fonte
  const votes = results.map((r) => {
    const badge =
      r.status === SRC_ONLINE   ? "✅" :
      r.status === SRC_OFFLINE  ? "🔴" :
      r.status === SRC_UNSTABLE ? "⚠️" : "❓";
    return `${badge} ${r.sourceName}`;
  });

  const affected = available
    .filter((r) => r.status !== SRC_ONLINE && r.detail)
    .map((r) => r.detail)
    .filter(Boolean)
    .slice(0, 2);

  const voteStr    = votes.join(" • ");
  const detailStr  = affected.length > 0 ? ` | ${affected.join(" | ")}` : "";

  return {
    finalStatus,
    detail: `${voteStr}${detailStr}`,
  };
}