/**
 * commands/index.ts — Registry central de comandos do bot.
 *
 * Padrão Command Handler: cada comando vive em seu próprio arquivo
 * e é registrado aqui. O bot.ts apenas importa este mapa e despacha.
 */

import { Message, TextChannel } from "discord.js";
import { statusCommand } from "./status";
import { relatorioCommand } from "./relatorio";
import { certificadoCommand } from "./certificado";
import { dbstatusCommand } from "./dbstatus";

export interface BotCommand {
  /** Nome do comando (sem prefixo). */
  name: string;
  /** Descrição curta para ajuda. */
  description: string;
  /** Executa o comando. */
  execute: (msg: Message, channel: TextChannel) => Promise<void>;
}

/** Mapa de comandos registrados. Chave = nome em lowercase. */
export const commands = new Map<string, BotCommand>();

function register(cmd: BotCommand): void {
  commands.set(cmd.name, cmd);
}

register(statusCommand);
register(relatorioCommand);
register(certificadoCommand);
register(dbstatusCommand);
