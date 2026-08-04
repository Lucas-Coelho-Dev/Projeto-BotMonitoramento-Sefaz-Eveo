/**
 * commands/certificado.ts — !certificado
 *
 * Exibe informações do certificado digital A1:
 * dias restantes, data de expiração, titular e emissor.
 */

import { Message, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { BotCommand } from "./index";
import { checkCertificateExpiry } from "../CertificateWatcher";
import { nowUtc, nowBrasilia } from "../monitors/BaseMonitor";

export const certificadoCommand: BotCommand = {
  name: "certificado",
  description: "Informações do certificado digital A1",

  async execute(_msg: Message, channel: TextChannel): Promise<void> {
    const certInfo = checkCertificateExpiry();

    if (!certInfo) {
      const embed = new EmbedBuilder()
        .setTitle("🔐 Certificado Digital")
        .setColor(Colors.DarkGrey)
        .setDescription(
          "Não foi possível ler o certificado.\n" +
          "Verifique `CERT_PATH` e `CERT_PASSWORD` no `.env`."
        )
        .setTimestamp(nowUtc());

      await channel.send({ embeds: [embed] });
      return;
    }

    const { daysRemaining, expiresAt, subject, issuer, valid } = certInfo;
    const expiryStr = expiresAt.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });

    let color: number;
    let title: string;

    if (!valid || daysRemaining <= 0) {
      color = 0xe74c3c;
      title = "🔴 CERTIFICADO DIGITAL EXPIRADO!";
    } else if (daysRemaining <= 15) {
      color = 0xe74c3c;
      title = "🔐 CERTIFICADO EXPIRANDO!";
    } else if (daysRemaining <= 30) {
      color = 0xe67e22;
      title = "🔐 Certificado — Atenção";
    } else {
      color = 0x2ecc71;
      title = "🔐 Certificado Digital — OK";
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setTimestamp(nowUtc())
      .addFields(
        { name: "⏳ Dias Restantes", value: `\`${daysRemaining}\``, inline: true },
        { name: "📅 Expira em", value: `\`${expiryStr}\``, inline: true },
        { name: "📋 Titular", value: `\`${subject.substring(0, 80)}\``, inline: false },
        { name: "🏛️ Emissor", value: `\`${issuer.substring(0, 80)}\``, inline: false },
      )
      .setFooter({ text: `${nowBrasilia()} (Brasília)` });

    if (!valid) {
      embed.setDescription("⚠️ O certificado **expirou**! Renove imediatamente.");
    } else if (daysRemaining <= 15) {
      embed.setDescription(`⚠️ Restam **${daysRemaining} dias**. Renove o certificado A1.`);
    } else if (daysRemaining <= 30) {
      embed.setDescription(`O certificado expira em **${daysRemaining} dias**. Planeje a renovação.`);
    } else {
      embed.setDescription(`✅ Certificado válido por mais **${daysRemaining} dias**.`);
    }

    await channel.send({ embeds: [embed] });
  },
};
