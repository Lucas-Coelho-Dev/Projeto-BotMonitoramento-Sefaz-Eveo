# 🚀 Bot PDV SEFAZ — Sistema Inteligente de Monitoramento e Alertabilidade

Sistema corporativo de monitoramento em tempo real da disponibilidade de serviços críticos de emissão fiscal (**SEFAZ NF-e / NFC-e**) e infraestrutura de servidores (**Eveo Cloud**), integrado com notificações dinâmicas via Discord.

---

## 📊 1. Visão Geral Executiva

### O Problema
Instabilidades e quedas na infraestrutura ou nos autorizadores estaduais da SEFAZ impedem a emissão de notas fiscais nas pontas de vendas (PDVs), gerando filas nos caixas, prejuízos financeiros e insatisfação dos clientes.

### A Solução
Um bot autônomo em **TypeScript (Node.js)** que realiza testes contínuos a cada 60 segundos, aplicando inteligência de **consenso ponderado** para eliminar alarmes falsos, e alertando as equipes certas no momento correto.

---

## 🏗️ 2. Arquitetura e Engenharia do Sistema

```mermaid
graph TD
    subgraph Fontes de Dados (Tripla Verificação SEFAZ)
        A[Ping Direto SOAP mTLS - Certificado A1] -->|Peso 4.0| D[Mecanismo de Consenso]
        B[Scraping Oficial Fazenda Nacional] -->|Peso 2.0| D
        C[API Pública Webmania] -->|Peso 1.0| D
    end

    subgraph Núcleo de Processamento
        D --> E[Filtro Anti-Flapping / Debounce 3 Ciclos]
        E --> F[(Banco SQLite - incident_log)]
    end

    subgraph Notificação Inteligente (Discord)
        F --> G{Horário Silencioso?}
        G -->|Sim 22h-08h| H[Log em Silêncio / Sem Menção]
        G -->|Não 08h-22h| I[Disparo com Menção de Cargos]
        H --> J[Relatório Matinal às 09h]
    end
```

---

## 🛡️ 3. Diferenciais Técnicos e Estabilidade

### A. Tripla Verificação com Consenso Ponderado
Para evitar falsos positivos por falhas temporárias de rede de terceiros, o status final é determinado por votos ponderados:
1. **Ping Direto SOAP (Peso 4.0 — Peso Dominante):** Conecta via TLS mútuo (`https.Agent`) diretamente aos Web Services SOAP estaduais (SP, RS, MG, PR, GO, etc.) usando o **Certificado Digital A1**.
2. **Fazenda Nacional (Peso 2.0):** Scraping do portal oficial do governo.
3. **Webmania (Peso 1.0):** API JSON de confirmação cruzada.

> **Regra de Decisão:** O Ping Direto sozinho (4.0) tem autoridade soberana. Se a Fazenda ou Webmania oscilarem mas o Ping Direto SOAP confirmar status saudável, o bot permanece em estado **ONLINE** sem alarmes falsos.

### B. Proteção Anti-Flapping (Debounce em 3 Ciclos)
Mudanças de estado (`ONLINE` → `INSTÁVEL` / `OFFLINE`) exigem **3 confirmações consecutivas** (3 minutos mantidos) antes de disparar alerta no canal. Flutuações de 1 ou 2 ciclos de rede são filtradas automaticamente.

### C. Alerta Inteligente de Expiração do Certificado Digital A1
* O bot inspeciona nativamente a validade do arquivo de Certificado Digital (`.pfx`).
* Todo dia às 10h faz a verificação:
  * **≤ 30 dias:** Alerta informativo de renovação (amarelo).
  * **≤ 15 dias:** Alerta urgente com menção à equipe responsável (vermelho).
  * **Expirado:** Alerta crítico imediato.

---

## ⏰ 4. Ciclo de Relatórios e Modo Silencioso

* **Modo Silencioso (22:00 às 08:00):** O monitoramento e o registro no banco continuam 24h, porém **nenhuma menção sonora (@everyone ou cargos)** é emitida durante a madrugada para não gerar incômodo desnecessário à equipe fora do expediente.
* **Relatório Matinal (09:00):** Exibe um compilado visual de todas as instabilidades registradas durante a madrugada, com horário de início, horário de término e duração exata de cada evento.
* **Relatórios Periódicos (13:00 e 18:00):** Resumo geral de disponibilidade durante o dia.

---

## 💬 5. Comandos do Bot no Discord

| Comando | Descrição |
|---|---|
| `!status` | Exibe o status em tempo real de todas as aplicações e a latência (ping) do bot. |
| `!relatorio` | Emite o relatório de status atual + a lista completa de incidentes das últimas 24 horas. |
| `!certificado` | Exibe a validade do Certificado Digital A1 (dias restantes, titular e data de expiração). |
| `!dbstatus` | Exibe os dados brutos e técnicos salvos na tabela SQLite (para auditoria e debug). |

---

## 🗄️ 6. Persistência de Dados (SQLite)

O sistema utiliza o banco de dados nativo **SQLite** via `better-sqlite3`, garantindo zero dependência de servidores externos de banco de dados:

* **`monitor_status`**: Armazena o estado atual em tempo real. Garante que se o bot for reiniciado na nuvem, ele recupera o estado anterior sem reemitir alertas antigos.
* **`incident_log`**: Tabela de auditoria histórica de quedas e instabilidades, armazenando timestamps e duração em segundos.

---

## 🚀 7. Implantação e Execução (Oracle Cloud / Linux)

### Pré-requisitos
* Node.js v18 ou superior
* Certificado Digital A1 (`.pfx`) na raiz do projeto

### Variáveis de Ambiente (`.env`)
```env
DISCORD_TOKEN=seu_token_discord
CHANNEL_ID=id_do_canal
CERT_PATH=./certificado.pfx
CERT_PASSWORD=senha_do_certificado

# Menções de Cargos no Discord (opcional)
ROLE_SUPORTE=
ROLE_RELACIONAMENTO=
ROLE_IMPLANTACAO=
ROLE_MARKETING=
```

### Comandos de Execução
```bash
# Instalação das dependências
npm install

# Compilação do TypeScript para JavaScript
npm run build

# Execução em Produção via PM2
pm2 start dist/bot.js --name "sefaz-discord-bot"
pm2 save
pm2 startup
```