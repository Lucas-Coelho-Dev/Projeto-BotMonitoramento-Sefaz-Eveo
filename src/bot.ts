/**
 * bot.ts — Ponto de entrada do Bot PDV SEFAZ (TypeScript / discord.js v14)
 *
 * Ciclo de monitoramento:
 *   - Verifica todos os serviços a cada 60s
 *   - Alertas imediatos em caso de mudança de status
 *
 * Cron jobs automáticos (horário Brasília):
 *   - 09:00 — Relatório matinal de quedas noturnas
 *   - 10:00 — Verificação do certificado digital
 *   - 13:00 — Relatório periódico
 *   - 18:00 — Relatório periódico
 *
 * Comandos:
 *   !status      — Status em tempo real
 *   !relatorio   — Status + incidentes 24h
 *   !certificado — Info do certificado A1
 *   !dbstatus    — Dados brutos do banco
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
  Colors,
  Message,
} from "discord.js";
import cron from "node-cron";
import { config } from "./config";
import { initDb, getIncidentsSince } from "./database";
import { Notifier } from "./notifier";
import { buildMention, isQuietHours } from "./notifier";
import { BaseMonitor, nowUtc, nowBrasilia } from "./monitors/BaseMonitor";
import { EveoMonitor } from "./monitors/EveoMonitor";
import { SefazMonitor } from "./monitors/SefazMonitor";
import { checkCertificateExpiry } from "./CertificateWatcher";
import { commands } from "./commands";
import logger from "./logger";

// ── Validação ─────────────────────────────────────────
if (!config.DISCORD_TOKEN) {
  logger.error("DISCORD_TOKEN não configurado!");
  process.exit(1);
}
if (!config.CHANNEL_ID) {
  logger.error("CHANNEL_ID não configurado!");
  process.exit(1);
}

// ── Cliente Discord ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Estado global ────────────────────────────────────
let monitors: BaseMonitor[] = [];
let startupReportSent = false;

/** Retorna os monitores ativos (usado pelos comandos). */
export function getMonitors(): BaseMonitor[] {
  return monitors;
}

/** Retorna o client do Discord (usado pelos comandos). */
export function getClient(): Client {
  return client;
}

// ── Inicialização ─────────────────────────────────────
client.once("ready", async () => {
  logger.info(`Bot conectado como ${client.user?.tag}`);

  initDb();

  const channel = client.channels.cache.get(config.CHANNEL_ID) as TextChannel;
  if (!channel) {
    logger.error("Canal não encontrado!");
    process.exit(1);
  }

  const notifier = new Notifier(channel);

  monitors = [
    new EveoMonitor(notifier),
    new SefazMonitor(notifier, "NFC-e", config.SEFAZ_NFCE_COMPONENTS),
    new SefazMonitor(notifier, "NF-e", config.SEFAZ_NFE_COMPONENTS),
  ];

  // ── Ciclo de monitoramento ────────────────────────
  const runChecks = async () => {
    await Promise.all(monitors.map((m) => m.check()));

    if (!startupReportSent) {
      startupReportSent = true;
      await sendReport(channel, "🚀 Bot iniciado");
    }
  };

  await runChecks();
  setInterval(runChecks, config.CHECK_INTERVAL_MS);

  // ── Cron jobs (UTC para evitar bugs de DST) ───────
  // 13:00 Brasília = 16:00 UTC
  cron.schedule("0 16 * * *", () => sendReport(channel, "📅 Relatório 13h"), { timezone: "UTC" });
  // 18:00 Brasília = 21:00 UTC
  cron.schedule("0 21 * * *", () => sendReport(channel, "📅 Relatório 18h"), { timezone: "UTC" });
  // 09:00 Brasília = 12:00 UTC — relatório matinal
  cron.schedule("0 12 * * *", () => sendMorningReport(channel), { timezone: "UTC" });
  // 10:00 Brasília = 13:00 UTC — verificação do certificado
  cron.schedule("0 13 * * *", () => sendCertificateCheck(channel), { timezone: "UTC" });
});

// ── Relatório periódico ──────────────────────────────
async function sendReport(channel: TextChannel, trigger: string): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${trigger}`)
    .setColor(Colors.Blue)
    .setTimestamp(nowUtc())
    .setFooter({ text: `${nowBrasilia()} (Brasília)` });

  for (const m of monitors) {
    embed.addFields({ name: m.displayName, value: m.statusField() });
  }

  await channel.send({ embeds: [embed] });
}

// ── Relatório matinal de quedas noturnas ─────────────
async function sendMorningReport(channel: TextChannel): Promise<void> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(22, 0, 0, 0);
  const sinceIso = yesterday.toISOString().replace("T", " ").substring(0, 19);

  const incidents = getIncidentsSince(sinceIso);

  const embed = new EmbedBuilder()
    .setTitle("🌅 Relatório Matinal — Quedas Noturnas")
    .setColor(incidents.length > 0 ? Colors.Gold : Colors.Green)
    .setTimestamp(nowUtc())
    .setDescription(
      "Resumo dos incidentes entre **22:00 de ontem** e **08:00 de hoje**."
    );

  if (incidents.length === 0) {
    embed.addFields({
      name: "Estabilidade",
      value: "✅ **Noite tranquila** — Nenhuma queda detectada.",
    });
  } else {
    for (const inc of incidents.slice(0, 8)) {
      const emoji = inc.status === "offline" ? "🔴" : "⚠️";
      const startStr = inc.started_at?.substring(11, 16) ?? "?";
      const endStr = inc.ended_at ? inc.ended_at.substring(11, 16) : "Em andamento";

      let durationStr = "N/A";
      if (inc.duration_sec) {
        const min = Math.floor(inc.duration_sec / 60);
        durationStr = min < 60
          ? `${min} min`
          : `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}m` : ""}`;
      }

      embed.addFields({
        name: `${emoji} ${inc.monitor_name} (${inc.status.toUpperCase()})`,
        value: `⏱️ \`${durationStr}\` (${startStr} → ${endStr}) • \`${inc.detail || "—"}\``,
      });
    }

    if (incidents.length > 8) {
      embed.setFooter({ text: `+ ${incidents.length - 8} incidentes não exibidos` });
    }
  }

  await channel.send({ embeds: [embed] });
}

// ── Verificação diária do certificado digital ────────
async function sendCertificateCheck(channel: TextChannel): Promise<void> {
  const certInfo = checkCertificateExpiry();
  if (!certInfo) return;

  const { daysRemaining, expiresAt, subject, valid } = certInfo;
  const expiryStr = expiresAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  // Só envia alerta automático se estiver perto de expirar
  if (daysRemaining > 30) return;

  let color: number;
  let title: string;
  let mention: string | undefined;

  if (!valid || daysRemaining <= 0) {
    color = 0xe74c3c;
    title = "🔴 CERTIFICADO DIGITAL EXPIRADO!";
    mention = buildMention(["ROLE_SUPORTE", "ROLE_IMPLANTACAO"]);
  } else if (daysRemaining <= 15) {
    color = 0xe74c3c;
    title = "🔐 CERTIFICADO EXPIRANDO!";
    mention = buildMention(["ROLE_SUPORTE", "ROLE_IMPLANTACAO"]);
  } else {
    color = 0xe67e22;
    title = "🔐 Certificado — Atenção";
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp(nowUtc())
    .addFields(
      { name: "⏳ Dias Restantes", value: `\`${daysRemaining}\``, inline: true },
      { name: "📅 Expira em", value: `\`${expiryStr}\``, inline: true },
      { name: "📋 Titular", value: `\`${subject.substring(0, 80)}\``, inline: false },
    )
    .setFooter({ text: `${nowBrasilia()} (Brasília)` });

  if (!valid) {
    embed.setDescription("⚠️ Certificado **expirado**! Renove imediatamente.");
  } else if (daysRemaining <= 15) {
    embed.setDescription(`⚠️ Restam **${daysRemaining} dias**. Renove o certificado A1.`);
  } else {
    embed.setDescription(`Certificado expira em **${daysRemaining} dias**. Planeje a renovação.`);
  }

  await channel.send({ content: mention, embeds: [embed] });
}

// ── Dispatch de comandos ─────────────────────────────
client.on("messageCreate", async (msg: Message) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!")) return;

  const cmdName = msg.content.slice(1).trim().toLowerCase();
  const channel = msg.channel as TextChannel;

  const command = commands.get(cmdName);
  if (command) {
    try {
      await command.execute(msg, channel);
    } catch (err) {
      logger.error(`Erro no comando !${cmdName}: ${err}`);
      await channel.send(`❌ Erro ao executar \`!${cmdName}\`.`);
    }
  }
});

// ── Erros ─────────────────────────────────────────────
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ── Login ─────────────────────────────────────────────
client.login(config.DISCORD_TOKEN);