import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * O que o assistente pede ao Claude, atrás de uma interface: o resto do código não
 * conhece o SDK, e os testes trocam isto por uma versão falsa.
 */
export interface Ia {
  extrair(entrada: EntradaExtracao): Promise<Extracao>;
  escrever(pedido: PedidoTexto): Promise<string>;
  agente(pedido: PedidoAgente): Promise<string>;
  /** Resposta em JSON validado pelo schema; `null` se o modelo recusar ou não fechar o JSON. */
  estruturar<T extends z.ZodType>(schema: T, pedido: PedidoTexto): Promise<z.infer<T> | null>;
}

export const ExtracaoSchema = z.object({
  compromissos: z
    .array(
      z.object({
        descricao: z.string().describe("O combinado, curto e concreto: 'mandar o orçamento da cozinha'"),
        quando: z
          .string()
          .nullable()
          .describe("Data/hora ISO 8601 com fuso, se a conversa der para saber; senão null"),
        responsavel: z.enum(["eu", "contato", "ambos"]).describe("'eu' = o dono do WhatsApp"),
      }),
    )
    .describe("Só compromissos e promessas novos do trecho marcado como NOVO"),
  fatos: z
    .array(z.string())
    .describe("Fatos duradouros sobre o contato que valem lembrar (família, trabalho, preferências)"),
  precisa_resposta: z.boolean().describe("A última mensagem é do contato e espera algo do dono"),
  urgente: z
    .boolean()
    .describe("Pede atenção do dono hoje: prazo para hoje, problema, cliente insatisfeito, emergência de família"),
  motivo_urgencia: z.string().describe("Em poucas palavras, por que é urgente; vazio se não for"),
  aguardando: z
    .string()
    .nullable()
    .describe("O que o DONO ficou esperando do contato e ainda não recebeu (ex.: 'as medidas da cozinha'); null se nada"),
});
export type Extracao = z.infer<typeof ExtracaoSchema>;

export interface EntradaExtracao {
  agora: string;
  dono: string;
  contato: string;
  grupo: boolean;
  memoria: string;
  anteriores: string;
  novas: string;
}

export interface PedidoTexto {
  sistema: string;
  conteudo: string;
  esforco?: "low" | "medium" | "high";
}

/** As ferramentas no formato que o tool runner do SDK aceita (`betaZodTool`). */
export type Ferramentas = Parameters<Anthropic["beta"]["messages"]["toolRunner"]>[0]["tools"];

export interface PedidoAgente {
  sistema: string;
  conteudo: string;
  ferramentas: Ferramentas;
  /** Servidor MCP remoto (o KoreOS), chamado pelo conector MCP da API do Claude. */
  mcp?: { nome: string; url: string; token: string };
}

const INSTRUCOES_EXTRACAO = `Você lê trechos de conversas do WhatsApp pessoal de uma pessoa (o "dono") para manter a agenda e a memória dela.
Extraia apenas o que está no trecho marcado como NOVO; o trecho ANTERIOR é só contexto.
- Compromisso: algo combinado com data ou prazo, ou uma promessa ("te mando amanhã", "passo aí sexta", "a gente se fala semana que vem"). Não invente datas: sem prazo dito, quando = null.
- Em grupos, só compromissos que envolvem o dono diretamente.
- Fatos: coisas duradouras sobre o contato (quem é, família, trabalho, aniversário, preferências). Nada passageiro ("está no trânsito").
- Urgente só quando o dono deveria ver hoje; conversa normal não é urgente.
- Aguardando: olhe a conversa inteira (ANTERIOR + NOVO). Se o contato ficou de mandar ou fazer algo para o dono e ainda não fez, descreva; se já entregou ou não há nada, null.
- Se não houver nada, devolva listas vazias.`;

// Recusas de classificador são raras neste uso, mas uma conversa pessoal pode cair num
// deles; "default" reencaminha no servidor para o modelo indicado pela categoria.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

export function criarIa(opts: { modelo: string; modeloExtracao: string; apiKey?: string }): Ia {
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    async extrair(e) {
      const conteudo = [
        `Agora: ${e.agora}`,
        `Dono: ${e.dono}`,
        `${e.grupo ? "Grupo" : "Contato"}: ${e.contato}`,
        e.memoria ? `O que já se sabe:\n${e.memoria}` : "",
        e.anteriores ? `ANTERIOR:\n${e.anteriores}` : "",
        `NOVO:\n${e.novas}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const resp = await client.beta.messages.parse({
        model: opts.modeloExtracao,
        max_tokens: 4000,
        ...FALLBACK,
        system: [{ type: "text", text: INSTRUCOES_EXTRACAO, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "low", format: betaZodOutputFormat(ExtracaoSchema) },
        messages: [{ role: "user", content: conteudo }],
      });
      if (resp.stop_reason === "refusal" || !resp.parsed_output) {
        return { compromissos: [], fatos: [], precisa_resposta: false, urgente: false, motivo_urgencia: "", aguardando: null };
      }
      return resp.parsed_output;
    },

    async escrever(p) {
      const resp = await client.beta.messages.create({
        model: opts.modelo,
        max_tokens: 8000,
        ...FALLBACK,
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: p.esforco ?? "medium" },
        messages: [{ role: "user", content: p.conteudo }],
      });
      if (resp.stop_reason === "refusal") return "";
      return textoDe(resp.content);
    },

    async estruturar(schema, p) {
      const resp = await client.beta.messages.parse({
        model: opts.modelo,
        max_tokens: 8000,
        ...FALLBACK,
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: p.esforco ?? "medium", format: betaZodOutputFormat(schema) },
        messages: [{ role: "user", content: p.conteudo }],
      });
      if (resp.stop_reason === "refusal") return null;
      return (resp.parsed_output ?? null) as z.infer<typeof schema> | null;
    },

    async agente(p) {
      // O MCP roda do lado da Anthropic: as ferramentas do KoreOS aparecem para o modelo
      // junto com as locais, e o runner só executa as locais.
      const mcp = p.mcp
        ? {
            betas: [...FALLBACK.betas, "mcp-client-2025-11-20"],
            mcp_servers: [{ type: "url" as const, name: p.mcp.nome, url: p.mcp.url, authorization_token: p.mcp.token }],
          }
        : {};
      const tools = p.mcp ? [...p.ferramentas, { type: "mcp_toolset" as const, mcp_server_name: p.mcp.nome }] : p.ferramentas;
      const final = await client.beta.messages.toolRunner({
        model: opts.modelo,
        max_tokens: 8000,
        ...FALLBACK,
        ...mcp,
        max_iterations: 12,
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "medium" },
        tools,
        messages: [{ role: "user", content: p.conteudo }],
      });
      if (final.stop_reason === "refusal") return "Não consegui responder isso.";
      return textoDe(final.content);
    },
  };
}

function textoDe(blocos: Anthropic.Beta.BetaContentBlock[]): string {
  return blocos
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
