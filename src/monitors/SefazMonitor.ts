/**
 * monitors/SefazMonitor.ts — Componente Orquestrador de Monitoramento SEFAZ
 *
 * ARQUITETURA DE TRIPLA VERIFICAÇÃO PONDERADA:
 * A cada ciclo de 60s, este monitor consulta em paralelo 3 fontes distintas:
 *   1. Ping Direto (SOAP mTLS com Certificado A1) -> Peso 4.0 (MAIS Confiável / Dominante)
 *   2. Fazenda Nacional (Scraping Oficial)        -> Peso 2.0 (Confirmação Governo)
 *   3. Webmania (API REST Pública)                -> Peso 1.0 (Confirmação Terceiros)
 *
 * REGRAS DE CONSENSO:
 *   - Como o Ping Direto (4.0) tem peso maior que a soma de Fazenda (2.0) + Webmania (1.0),
 *     ele possui autoridade soberana para evitar falsos alertas caso sites terceiros oscilem.
 *   - Fontes indisponíveis/timeout são ignoradas no cálculo do consenso.
 *
 * MONITORES INSTANCIADOS NO BOT:
 *   - SEFAZ NFC-e (Nota Fiscal de Consumidor Eletrônica)
 *   - SEFAZ NF-e  (Nota Fiscal Eletrônica de Grande Porte)
 */

import { BaseMonitor, FetchResult, INotifier, ONLINE, UNSTABLE, OFFLINE, UNKNOWN } from "./BaseMonitor";
import { checkFazenda } from "./sources/FazendaSource";
import { checkWebmania } from "./sources/WebmaniaSource";
import { checkDirectPing } from "./sources/DirectPingSource";
import { resolveConsensus, SRC_UNKNOWN } from "./types";

export class SefazMonitor extends BaseMonitor {
  private readonly docType:    string;
  private readonly components: readonly string[];

  constructor(notifier: INotifier, docType: string, components: readonly string[]) {
    super(notifier, `SEFAZ ${docType}`);
    this.docType    = docType;
    this.components = components;
  }

  async fetchStatus(): Promise<FetchResult> {
    // 1. Execução Concorrente/Paralela das 3 fontes para performance máxima
    const [pingDireto, fazenda, webmania] = await Promise.all([
      checkDirectPing(this.docType, this.components),
      checkFazenda   (this.docType, this.components),
      checkWebmania  (this.docType, this.components),
    ]);

    // Log detalhado de telemetria por fonte
    this.log.info(
      `[${this.docType}] ` +
      `PingDireto=${pingDireto.status.toUpperCase()} | ` +
      `Fazenda=${fazenda.status.toUpperCase()} | ` +
      `Webmania=${webmania.status.toUpperCase()}`
    );

    // 2. Resolução do Consenso Ponderado
    const sources = [pingDireto, fazenda, webmania];
    const { finalStatus, detail } = resolveConsensus(sources);

    // 3. Mapeamento do resultado do consenso para o enum interno do BaseMonitor
    const mapped =
      finalStatus === SRC_UNKNOWN ? UNKNOWN  :
      finalStatus === "offline"   ? OFFLINE  :
      finalStatus === "instável"  ? UNSTABLE :
      ONLINE;

    // 4. Média de tempo de resposta entre as fontes funcionais (em milissegundos)
    const responseTimes = sources
      .map((r) => r.responseMs)
      .filter((ms): ms is number => ms !== null);
    const avgMs = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : null;

    return [mapped, avgMs, detail];
  }
}