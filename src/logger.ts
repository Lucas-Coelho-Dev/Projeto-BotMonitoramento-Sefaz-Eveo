/**
 * logger.ts — Logger centralizado com Winston
 *
 * Saída simultânea para:
 *   - Console (colorido, tempo real)
 *   - Arquivo logs/bot.log (rotação diária, 30 dias de histórico)
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const fmt = winston.format.printf(({ level, message, label, timestamp }) => {
  const lbl = label ? `[${label}]` : "";
  return `${timestamp} [${level.toUpperCase()}] ${lbl} ${message}`;
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    fmt
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        fmt
      ),
    }),
    new DailyRotateFile({
      filename: path.join(logsDir, "bot-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      zippedArchive: false,
    }),
  ],
});

/** Cria um logger filho com um label (nome do monitor ou módulo). */
export function getLogger(label: string) {
  return logger.child({ label });
}

export default logger;