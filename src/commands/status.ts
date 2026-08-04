/**
 * commands/status.ts — !status
 *
 * Mostra o status em tempo real de todos os serviços monitorados,
 * com latência do bot e horário da última verificação.
 */

import { Message, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { BotCommand } from "./index";
import { getMonitors, getClient } from "../bot";
import { STATUS_EMOJI, nowUtc, nowBrasilia } from "../monitors/BaseMonitor";

export const statusCommand: BotCommand = {
  name: "status",
  description: "Status em tempo real de todos os serviços",

  async execute(_msg: Message, channel: TextChannel): Promise<void> {
    const monitors = getMonitors();
    const client = getClient();

    if (monitors.length === 0) {
      await channel.send("⏳ Inicializando...");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 Status dos Serviços")
      .setColor(Colors.Blurple)
      .setTimestamp(nowUtc())
      .setFooter({ text: `🏓 Ping: ${client.ws.ping}ms • ${nowBrasilia()} (Brasília)` });

    for (const m of monitors) {
      embed.addFields({
        name: m.displayName,
        value: m.statusField(),
      });
    }

    await channel.send({ embeds: [embed] });
  },
};
