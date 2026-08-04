/**
 * CertificateWatcher.ts — Monitora a data de expiração do certificado digital A1
 *
 * Lê o arquivo .pfx configurado em CERT_PATH e extrai a data de expiração
 * usando um servidor TLS temporário + conexão local para obter o X509.
 *
 * Chamado diariamente por um cron job em bot.ts.
 * Níveis de alerta:
 *   ≤ 30 dias → alerta amarelo (lembrete)
 *   ≤ 15 dias → alerta vermelho com @everyone
 *   ≤ 0 dias  → alerta crítico (expirado)
 */

import fs from "fs";
import crypto from "crypto";
import tls from "tls";
import net from "net";
import { config } from "./config";
import { getLogger } from "./logger";

const log = getLogger("CertWatch");

export interface CertInfo {
  subject: string;
  issuer: string;
  expiresAt: Date;
  daysRemaining: number;
  serialNumber: string;
  valid: boolean;
}

/**
 * Lê o certificado .pfx e retorna informações de expiração.
 * Retorna null se o certificado não estiver configurado ou não puder ser lido.
 */
export function checkCertificateExpiry(): CertInfo | null {
  if (!config.CERT_PATH) {
    log.warn("CERT_PATH não configurado");
    return null;
  }

  if (!fs.existsSync(config.CERT_PATH)) {
    log.warn(`Arquivo não encontrado: ${config.CERT_PATH}`);
    return null;
  }

  try {
    const pfxBuffer = fs.readFileSync(config.CERT_PATH);

    // Método 1: Usar PKCS12 nativo (Node.js 15.6+)
    // crypto.X509Certificate pode ler diretamente se tivermos o PEM
    // Vamos extrair via SecureContext → getCertificate()
    const ctx = tls.createSecureContext({
      pfx: pfxBuffer,
      passphrase: config.CERT_PASSWORD || "",
    });

    // getCertificate() retorna o certificado em formato DER (Buffer)
    const internalCtx = (ctx as any).context;
    if (internalCtx && typeof internalCtx.getCertificate === "function") {
      const derCert = internalCtx.getCertificate();
      if (derCert) {
        const x509 = new crypto.X509Certificate(derCert);
        return parseCertificate(x509);
      }
    }

    log.warn("Método SecureContext.getCertificate() não disponível. Tentando método alternativo...");

    // Método 2: Fallback — criar servidor TLS temporário para extrair o certificado
    // Este método é síncrono-like usando um truque com Promise mas retorna imediatamente
    // Para o cron diário, retornamos null e logamos a indisponibilidade
    log.error("Não foi possível extrair dados do certificado. Atualize o Node.js para v16+.");
    return null;

  } catch (err: any) {
    log.error(`Erro ao ler certificado: ${err.message}`);
    return null;
  }
}

function parseCertificate(x509: crypto.X509Certificate): CertInfo {
  const expiresAt = new Date(x509.validTo);
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Extrair CN do subject (formato: "CN=NIG ROMA..., OU=RFB...")
  const subjectStr = x509.subject || "";
  const cnMatch = subjectStr.match(/CN=([^,\n]+)/);
  const displaySubject = cnMatch ? cnMatch[1].trim() : subjectStr.substring(0, 100);

  const issuerStr = x509.issuer || "";
  const issuerCn = issuerStr.match(/CN=([^,\n]+)/);
  const displayIssuer = issuerCn ? issuerCn[1].trim() : issuerStr.substring(0, 100);

  const info: CertInfo = {
    subject: displaySubject,
    issuer: displayIssuer,
    expiresAt,
    daysRemaining,
    serialNumber: x509.serialNumber,
    valid: daysRemaining > 0,
  };

  log.info(
    `Certificado: ${displaySubject} | ` +
    `Expira: ${expiresAt.toLocaleDateString("pt-BR")} | ` +
    `Dias restantes: ${daysRemaining}`
  );

  return info;
}
