import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { config } from "../../config";
import { getLogger } from "../../logger";

const log = getLogger("ResilientFetch");

/**
 * Retorna um User-Agent aleatório a partir da lista configurada.
 */
export function getRandomUserAgent(): string {
  const list = config.USER_AGENTS;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

/**
 * Helper para requisições Axios com retentativas automáticas e backoff exponencial.
 */
export async function axiosGetWithRetry<T = any>(
  url: string,
  options: AxiosRequestConfig = {},
  retries = 2,
  delayMs = 1000
): Promise<AxiosResponse<T>> {
  try {
    return await axios.get<T>(url, options);
  } catch (err: any) {
    const isRetryable =
      retries > 0 &&
      (err.code === "ECONNABORTED" || // Timeout de conexão
       err.code === "ETIMEDOUT" ||
       err.code === "ECONNRESET" ||
       err.message.includes("timeout") ||
       (err.response && err.response.status >= 500)); // Erros de servidor 5xx

    if (isRetryable) {
      log.warn(
        `Falha na requisição para ${url} (${err.message}). ` +
        `Retentando em ${delayMs}ms... (${retries} tentativa(s) restante(s))`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return axiosGetWithRetry<T>(url, options, retries - 1, delayMs * 2);
    }
    throw err;
  }
}
