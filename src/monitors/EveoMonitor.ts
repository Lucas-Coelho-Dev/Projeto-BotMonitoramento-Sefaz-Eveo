/**
 * monitors/EveoMonitor.ts — Monitor do status.eveo.com.br
 *
 * Fonte: API pública do Status.io (plataforma usada pela Eveo)
 * Endpoint: GET https://api.status.io/1.0/status/66d5ff1580a4e633c1aec154
 *
 * Retorna JSON com:
 *   status_overall  → status geral da página
 *   status[]        → cada componente e seus data centers (containers)
 *   incidents[]     → incidentes ativos
 *   maintenance     → manutenções ativas/agendadas
 *
 * Códigos de status (Status.io):
 *   100 → Operational
 *   200 → Planned Maintenance
 *   300 → Degraded Performance
 *   400 → Partial Service Disruption
 *   500 → Service Disruption
 *   600 → Security Event
 *
 * Estados de incidente:
 *   100 → Investigating   (aberto — alerta)
 *   200 → Identified      (aberto — alerta)
 *   300 → Monitoring      (correção aplicada — ignorar, equivale a resolvido)
 *   400 → Resolved        (resolvido — ignorar)
 */

import axios from "axios";
import { config } from "../config";
import { BaseMonitor, FetchResult, INotifier, ONLINE, UNSTABLE, OFFLINE } from "./BaseMonitor";

// Estado a partir do qual o incidente é considerado resolvido (300 = Monitoring)
const INCIDENT_RESOLVED_STATE = 300;

interface Container {
  name: string;
  status_code: number;
}

interface Component {
  name: string;
  status_code: number;
  containers?: Container[];
}

interface IncidentMessage {
  state: number;
}

interface Incident {
  name: string;
  messages: IncidentMessage[];
  containers_affected?: { name: string }[];
}

interface Maintenance {
  name: string;
}

interface ApiResult {
  status_overall: { status: string; status_code: number };
  status: Component[];
  incidents: Incident[];
  maintenance: { active: Maintenance[]; upcoming: Maintenance[] };
}

function mapCode(code: number): string {
  if (code >= 500) return OFFLINE;
  if (code >= 200) return UNSTABLE;
  return ONLINE;
}

function codeLabel(code: number): string {
  const labels: Record<number, string> = {
    100: "Operational",
    200: "Manutenção",
    300: "Degradado",
    400: "Interrupção Parcial",
    500: "Interrupção",
    600: "Evento de Segurança",
  };
  return labels[code] ?? `Código ${code}`;
}

function dcMatchesFilter(dcName: string): boolean {
  if (!config.EVEO_FILTER_DATACENTERS || config.EVEO_FILTER_DATACENTERS.length === 0) return true;
  return config.EVEO_FILTER_DATACENTERS.some((f) =>
    dcName.toLowerCase().includes(f.toLowerCase())
  );
}

export class EveoMonitor extends BaseMonitor {
  constructor(notifier: INotifier) {
    const label =
      config.EVEO_FILTER_DATACENTERS.length > 0
        ? `Eveo Status (${config.EVEO_FILTER_DATACENTERS.join("/")})`
        : "Eveo Status";
    super(notifier, label);
  }

  async fetchStatus(): Promise<FetchResult> {
    const start = Date.now();
    let data: { result: ApiResult };

    try {
      const res = await axios.get<{ result: ApiResult }>(config.EVEO_API_URL, {
        timeout: config.TIMEOUT_MS,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; DiscordMonitorBot/2.0)" },
      });
      const elapsed = Date.now() - start;

      if (res.status !== 200) {
        this.log.warn(`API HTTP ${res.status} | ${elapsed}ms`);
        return [OFFLINE, elapsed, `API inacessível (HTTP ${res.status})`];
      }

      if (elapsed > config.SLOW_THRESHOLD_MS) {
        return [UNSTABLE, elapsed, `API respondendo lentamente (${elapsed}ms)`];
      }

      data = res.data;
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      if (axios.isAxiosError(err) && err.code === "ECONNABORTED") {
        this.log.warn("Timeout na API Status.io");
        return [OFFLINE, null, "Timeout ao consultar API"];
      }
      this.log.error(`Erro inesperado: ${err}`);
      return [OFFLINE, elapsed || null, String(err)];
    }

    return this._analyze(data.result, Date.now() - start);
  }

  _analyze(result: ApiResult, elapsedMs: number): FetchResult {
    const overallCode = result.status_overall?.status_code ?? 100;
    const overallStr  = result.status_overall?.status ?? "Operational";
    const components  = result.status ?? [];

    const affectedContainers: string[] = [];
    const affectedComponents: string[] = [];
    let worstCode = 100;
    let monitoredDcCount = 0;

    for (const comp of components) {
      const compName = comp.name;
      const compCode = comp.status_code ?? 100;
      const dcs      = comp.containers ?? [];

      if (dcs.length === 0) {
        // Componente sem DCs (ex: Portal EVEO N/A)
        if (!config.EVEO_FILTER_DATACENTERS || config.EVEO_FILTER_DATACENTERS.length === 0) {
          if (compCode > worstCode) worstCode = compCode;
          if (compCode > 100) affectedComponents.push(`${compName} (${codeLabel(compCode)})`);
        }
        continue;
      }

      for (const dc of dcs) {
        if (!dcMatchesFilter(dc.name)) continue;
        monitoredDcCount++;
        const dcCode = dc.status_code ?? 100;
        if (dcCode > worstCode) worstCode = dcCode;
        if (dcCode > 100) {
          affectedContainers.push(`${compName} › ${dc.name} (${codeLabel(dcCode)})`);
        }
      }
    }

    // Incidentes ativos que afetam DCs monitorados
    const activeIncidents: string[] = [];
    for (const inc of result.incidents ?? []) {
      const messages  = inc.messages ?? [];
      const lastState = messages.length > 0 ? messages[messages.length - 1].state : 0;
      if (lastState >= INCIDENT_RESOLVED_STATE) continue;

      const contsAff = (inc.containers_affected ?? []).map((c) => c.name);
      if (config.EVEO_FILTER_DATACENTERS.length > 0) {
        const dcHit = contsAff.length > 0
          ? contsAff.some((dc) => dcMatchesFilter(dc))
          : false; // sem DCs especificados → não assume que afeta SP
        if (dcHit) activeIncidents.push(inc.name);
      } else {
        activeIncidents.push(inc.name);
      }
    }

    const maintenanceNames = (result.maintenance?.active ?? []).map((m) => m.name);

    let finalStatus = mapCode(worstCode);
    if (activeIncidents.length > 0 && finalStatus === ONLINE) finalStatus = UNSTABLE;

    const parts: string[] = [];
    if (affectedContainers.length > 0)
      parts.push("DCs afetados: " + affectedContainers.slice(0, 4).join(", "));
    else if (affectedComponents.length > 0)
      parts.push("Serviços afetados: " + affectedComponents.slice(0, 4).join(", "));
    if (activeIncidents.length > 0)
      parts.push("Incidente: " + activeIncidents.slice(0, 2).join("; "));
    if (maintenanceNames.length > 0)
      parts.push("Manutenção: " + maintenanceNames.slice(0, 2).join("; "));
    if (parts.length === 0) {
      const dcLabel = monitoredDcCount > 0
        ? `${monitoredDcCount} DC(s)`
        : `${components.length} serviço(s)`;
      parts.push(`${dcLabel} operacionais`);
    }

    const detail = parts.join(" | ");
    const filterInfo = config.EVEO_FILTER_DATACENTERS.length > 0
      ? `filtro=[${config.EVEO_FILTER_DATACENTERS.join(",")}]`
      : "sem filtro";

    this.log.info(
      `API OK | overall=${overallStr} | worstCode=${worstCode} | ` +
      `final=${finalStatus.toUpperCase()} | DCs=${monitoredDcCount} | ` +
      `${filterInfo} | ${elapsedMs}ms`
    );

    return [finalStatus, elapsedMs, detail];
  }
}