/**
 * notifier.ts — Monta e envia embeds de alerta no Discord.
 *
 * Menções:
 *   - Se ROLE_SUPORTE / ROLE_IMPLANTACAO etc. estiverem configurados → usa <@&ID>
 *   - Se nenhum role ID estiver configurado → usa @everyone (fallback)
 *   - No horário silencioso (22h-08h) → nenhuma menção
 *
 * Regras de menção por tipo de alerta:
 *   OFFLINE   → suporte + implantação
 *   INSTÁVEL  → suporte
 *   ONLINE    → sem menção (recuperou)
 */

import { TextChannel, EmbedBuilder } from "discord.js";
import { config } from "./config";
import {
  BaseMonitor,
  INotifier,
  ONLINE,
  UNSTABLE,
  OFFLINE,
  STATUS_EMOJI,
  STATUS_COLOR,
  nowUtc, nowBrasilia,
} from "./monitors/BaseMonitor";
import logger from "./logger";
 
const TITLES: Record<string, string> = {
  [ONLINE]:   "✅ Serviço Recuperado",
  [UNSTABLE]: "⚠️ Serviço Instável",
  [OFFLINE]:  "🔴 Serviço Fora do Ar",
};
 
const DESCRIPTIONS: Record<string, string> = {
  [ONLINE]:   "O serviço voltou a operar normalmente.",
  [UNSTABLE]: "O serviço está respondendo com lentidão ou apresentando problemas parciais.",
  [OFFLINE]:  "O serviço não está respondendo ou retornou um erro.",
};

/**
 * Verifica se o horário atual em Brasília está dentro do período silencioso.
 * Ex: QUIET_HOUR_START=22, QUIET_HOUR_END=8 → silêncio entre 22:00 e 07:59.
 */
export function isQuietHours(): boolean {
  const now = new Date();
  const brasiliaHour = parseInt(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }).format(now),
    10
  );

  const start = config.QUIET_HOUR_START;
  const end = config.QUIET_HOUR_END;

  // Caso que cruza meia-noite: ex 22-08
  if (start > end) {
    return brasiliaHour >= start || brasiliaHour < end;
  }
  // Caso normal: ex 01-06
  return brasiliaHour >= start && brasiliaHour < end;
}

/**
 * Monta a string de menção baseada nos cargos configurados.
 * Se nenhum role ID estiver configurado, retorna @everyone.
 * Recebe um array de chaves de config para mencionar.
 */
export function buildMention(roleKeys: (keyof typeof config)[]): string {
  const roleIds = roleKeys
    .map((key) => config[key] as string)
    .filter((id) => id.length > 0);

  if (roleIds.length === 0) {
    return "@everyone";
  }

  return roleIds.map((id) => `<@&${id}>`).join(" ");
}

export class Notifier implements INotifier {
  constructor(private channel: TextChannel) {}
 
  async sendAlert(
    monitor: BaseMonitor,
    newStatus: string,
    previousStatus: string,
    responseMs: number | null,
    detail: string
  ): Promise<void> {
    const color   = STATUS_COLOR[newStatus] ?? 0x95a5a6;
    const emoji   = STATUS_EMOJI[newStatus] ?? "❓";
    const pEmoji  = STATUS_EMOJI[previousStatus] ?? "❓";
    const msStr   = responseMs !== null ? `\`${responseMs}ms\`` : "`Timeout`";

    const quiet = isQuietHours();
 
    const embed = new EmbedBuilder()
      .setTitle(TITLES[newStatus] ?? "🔔 Mudança de Status")
      .setDescription(
        (DESCRIPTIONS[newStatus] ?? "Status do serviço mudou.") +
        (quiet ? "\n🔇 *Modo silencioso ativo (22h-08h)*" : "")
      )
      .setColor(color)
      .setTimestamp(nowUtc())
      .addFields(
        { name: "🖥️ Serviço",          value: `\`${monitor.displayName}\``,                                              inline: true },
        { name: "🔄 Mudança",           value: `${pEmoji} \`${previousStatus.toUpperCase()}\` → ${emoji} \`${newStatus.toUpperCase()}\``, inline: true },
        { name: "⏱️ Tempo de Resposta", value: msStr,                                                                      inline: true }
      )
      .setFooter({ text: `Monitor de Serviços • ${nowBrasilia()} (Brasília)` });
 
    if (detail) embed.addFields({ name: "📋 Detalhe", value: detail, inline: false });
 
    // Monta a menção apropriada (silenciada no horário silencioso)
    let mention: string | undefined;

    if (!quiet) {
      if (newStatus === OFFLINE) {
        mention = buildMention(["ROLE_SUPORTE", "ROLE_IMPLANTACAO"]);
      } else if (newStatus === UNSTABLE) {
        mention = buildMention(["ROLE_SUPORTE"]);
      }
      // ONLINE (recuperou) → sem menção
    }

    try {
      await this.channel.send({ content: mention, embeds: [embed] });
      logger.info(`[${monitor.displayName}] ${previousStatus} → ${newStatus}${quiet ? " (silencioso)" : ""}`);
    } catch (err) {
      logger.error(`Erro ao enviar alerta: ${err}`);
    }
  }
}