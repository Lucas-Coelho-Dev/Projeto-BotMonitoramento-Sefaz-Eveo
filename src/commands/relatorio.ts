/**
 * commands/relatorio.ts — !relatorio
 *
 * Relatório completo: status atual de todos os serviços
 * + histórico de incidentes das últimas 24 horas.
 */

import { Message, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { BotCommand } from "./index";
import { getMonitors } from "../bot";
import { getIncidentsSince } from "../database";
import { nowUtc, nowBrasilia } from "../monitors/BaseMonitor";

export const relatorioCommand: BotCommand = {
  name: "relatorio",
  description: "Relatório completo com status + incidentes das últimas 24h",

  async execute(_msg: Message, channel: TextChannel): Promise<void> {
    const monitors = getMonitors();

    // ── Embed 1: Status atual ───────────────────────────
    const statusEmbed = new EmbedBuilder()
      .setTitle("📋 Relatório de Status")
      .setColor(Colors.Blue)
      .setTimestamp(nowUtc())
      .setFooter({ text: `${nowBrasilia()} (Brasília)` });

    for (const m of monitors) {
      statusEmbed.addFields({
        name: m.displayName,
        value: m.statusField(),
      });
    }

    // ── Embed 2: Incidentes últimas 24h ─────────────────
    const since = new Date();
    since.setHours(since.getHours() - 24);
    const sinceIso = since.toISOString().replace("T", " ").substring(0, 19);
    const incidents = getIncidentsSince(sinceIso);

    const incidentEmbed = new EmbedBuilder()
      .setTitle("📜 Incidentes — Últimas 24 Horas")
      .setColor(incidents.length > 0 ? Colors.Gold : Colors.Green)
      .setTimestamp(nowUtc());

    if (incidents.length === 0) {
      incidentEmbed.setDescription("✅ **Nenhum incidente registrado nas últimas 24 horas.**");
    } else {
      for (const inc of incidents.slice(0, 10)) {
        const statusEmoji = inc.status === "offline" ? "🔴" : "⚠️";
        const startStr = inc.started_at?.substring(11, 16) ?? "?";
        const endStr = inc.ended_at ? inc.ended_at.substring(11, 16) : "Em andamento";

        let durationStr = "N/A";
        if (inc.duration_sec) {
          const min = Math.floor(inc.duration_sec / 60);
          if (min < 60) {
            durationStr = `${min} min`;
          } else {
            const hr = Math.floor(min / 60);
            const remMin = min % 60;
            durationStr = `${hr}h${remMin > 0 ? ` ${remMin}m` : ""}`;
          }
        }

        incidentEmbed.addFields({
          name: `${statusEmoji} ${inc.monitor_name} (${inc.status.toUpperCase()})`,
          value: `⏱️ **Duração:** \`${durationStr}\` (${startStr} → ${endStr})\n📋 \`${inc.detail || "Sem detalhes"}\``,
        });
      }

      if (incidents.length > 10) {
        incidentEmbed.setFooter({ text: `+ ${incidents.length - 10} incidentes não exibidos` });
      }
    }

    await channel.send({ embeds: [statusEmbed, incidentEmbed] });
  },
};
