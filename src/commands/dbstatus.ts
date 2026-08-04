/**
 * commands/dbstatus.ts — !dbstatus
 *
 * Status técnico: dados brutos do banco de dados SQLite,
 * útil para debug e verificação de integridade.
 */

import { Message, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { BotCommand } from "./index";
import { readAll } from "../database";
import { nowUtc } from "../monitors/BaseMonitor";

export const dbstatusCommand: BotCommand = {
  name: "dbstatus",
  description: "Dados brutos do banco de dados (debug)",

  async execute(_msg: Message, channel: TextChannel): Promise<void> {
    const rows = readAll();

    if (rows.length === 0) {
      await channel.send("🗄️ Banco de dados vazio.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🗄️ Status do Banco de Dados")
      .setColor(Colors.DarkGrey)
      .setTimestamp(nowUtc())
      .setDescription("Dados brutos da tabela `monitor_status`.");

    for (const r of rows) {
      const status = r.status?.toUpperCase() ?? "N/A";
      const ms = r.response_ms !== null ? `${r.response_ms}ms` : "N/A";
      const detail = r.detail ? `\n> ${r.detail.substring(0, 100)}` : "";

      embed.addFields({
        name: r.monitor_name,
        value: `\`${status}\` — \`${ms}\`${detail}`,
      });
    }

    await channel.send({ embeds: [embed] });
  },
};
