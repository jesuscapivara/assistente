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
  /** O que a foto mostra, numa frase: é o que deixa o assistente reagir a ela. */
  verImagem(imagem: { buffer: Buffer; mimetype: string }, legenda: string): Promise<string>;
}

export const ExtracaoSchema = z.object({
  compromissos: z
    .array(
      z.object({
        descricao: z.string().describe("O combinado, curto e concreto, com quem faz como sujeito: 'mandar o orçamento da cozinha'"),
        quando: z
          .string()
          .nullable()
          .describe("Data/hora ISO 8601 com fuso, se a conversa der para saber; senão null"),
        // "eu" confundia o modelo: numa conversa os dois lados dizem "eu". Quem promete
        // "vou ler" é o responsável, mesmo que a coisa a ler tenha vindo do dono.
        quem_faz: z
          .enum(["dono", "contato", "ambos"])
          .describe("Quem tem que fazer: 'dono' é o dono do WhatsApp; 'contato' é a outra pessoa. Quem disse 'vou fazer' é quem faz"),
      }),
    )
    .describe("Só compromissos e promessas novos do trecho marcado como NOVO"),
  fatos: z
    .array(z.string())
    .describe("Fatos duradouros sobre o contato que valem lembrar (família, trabalho, preferências)"),
  precisa_resposta: z.boolean().describe("A última mensagem é do contato e espera algo do dono"),
  reacao: z
    .boolean()
    .describe(
      "A última mensagem é do contato e compartilha algo sem pedir nada (foto, vídeo, novidade, conquista, notícia boa) que pede só uma reação curta do dono",
    ),
  urgente: z
    .boolean()
    .describe("Pede atenção do dono hoje: prazo para hoje, problema, cliente insatisfeito, emergência de família"),
  motivo_urgencia: z.string().describe("Em poucas palavras, por que é urgente; vazio se não for"),
  aguardando: z
    .string()
    .nullable()
    .describe("O que o DONO ficou esperando do contato e ainda não recebeu (ex.: 'as medidas da cozinha'); null se nada"),
  situacao: z
    .string()
    .describe(
      "Em uma frase, para o dono, onde a conversa está agora, ligando a última mensagem ao que veio antes. Ex.: 'Você convidou a Ana para jantar; ela respondeu que sábado está mais livre — falta você propor o horário.' Vazio se não há nada em andamento",
    ),
  automatica: z
    .boolean()
    .describe("O outro lado é um sistema, não uma pessoa: notificação automática, banco, loja, código de verificação, robô"),
  sugestoes: z
    .array(z.string())
    .describe(
      "Só se precisa_resposta: 2 ou 3 caminhos de resposta, curtos (até 6 palavras), como o dono pediria a um assistente: 'Sábado às 10h', 'Próxima semana', 'Peço as medidas'. Nunca prometa valor nem prazo que a conversa não tem. Vazio se não precisa resposta",
    ),
});
export type Extracao = z.infer<typeof ExtracaoSchema>;

export const EXTRACAO_VAZIA: Extracao = {
  compromissos: [],
  fatos: [],
  precisa_resposta: false,
  reacao: false,
  urgente: false,
  motivo_urgencia: "",
  aguardando: null,
  situacao: "",
  automatica: false,
  sugestoes: [],
};

export interface EntradaExtracao {
  agora: string;
  dono: string;
  contato: string;
  grupo: boolean;
  memoria: string;
  anteriores: string;
  novas: string;
  /** O que o dono já corrigiu em leituras anteriores; vale acima destas instruções. */
  licoes?: string;
}

/**
 * `leve` vai para o modelo barato (MODELO_LEVE): ler, resumir, classificar. `normal` é
 * para o que pede julgamento ou a voz do dono. A diferença de preço chega a 20 vezes.
 */
export type Peso = "leve" | "normal";

export interface PedidoTexto {
  sistema: string;
  conteudo: string;
  esforco?: "low" | "medium" | "high";
  peso?: Peso;
  /** Rótulo da chamada na tabela de consumo ("ficha", "rascunho"...). */
  funcao: string;
}

/** Tokens de uma chamada, para a tabela `consumo`. */
export interface Uso {
  funcao: string;
  modelo: string;
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

/** As ferramentas no formato que o tool runner do SDK aceita (`betaZodTool`). */
export type Ferramentas = Parameters<Anthropic["beta"]["messages"]["toolRunner"]>[0]["tools"];

export interface PedidoAgente {
  funcao?: string;
  sistema: string;
  conteudo: string;
  ferramentas: Ferramentas;
  /** Servidor MCP remoto (o KoreOS), chamado pelo conector MCP da API do Claude. */
  mcp?: { nome: string; url: string; token: string };
}

const INSTRUCOES_EXTRACAO = `Você lê trechos de conversas do WhatsApp pessoal de uma pessoa (o "dono") para manter a agenda e a memória dela.
Extraia apenas o que está no trecho marcado como NOVO; o trecho ANTERIOR é só contexto.
- Compromisso: algo combinado com data ou prazo, ou uma promessa ("te mando amanhã", "passo aí sexta", "a gente se fala semana que vem"). Não invente datas: sem prazo dito, quando = null.
- Quem faz: veja quem escreveu a promessa. Se o contato escreve "vou ler", "te mando amanhã", "não terminei de ler", quem faz é o contato, ainda que o arquivo tenha sido mandado pelo dono. Só é do dono o que o dono prometeu ou o que pediram a ele e ele aceitou.
- Em grupos, só compromissos que envolvem o dono diretamente.
- Fatos: coisas duradouras sobre o contato (quem é, família, trabalho, aniversário, preferências). Nada passageiro ("está no trânsito").
- Urgente só quando o dono deveria ver hoje; conversa normal não é urgente.
- Aguardando: olhe a conversa inteira (ANTERIOR + NOVO). Se o contato ficou de mandar ou fazer algo para o dono e ainda não fez, descreva; se já entregou ou não há nada, null.
- Precisa resposta: só se a última mensagem é do contato e pede algo do dono (pergunta, proposta, pedido, convite em aberto). "Ok", "valeu", "disponha", "tá ok", emoji ou fim de assunto não pedem resposta.
- Reação: a última mensagem é do contato e mostra algo sem pedir nada (foto do produto novo, obra pronta, aprovação saiu, vídeo, notícia boa). Não é "precisa resposta", mas pede um "que legal" do dono. Se o dono já reagiu, não é.
- Situação: leia também as mensagens do dono. Uma resposta curta do contato ("sábado eu estaria mais livre") só faz sentido junto com o que o dono disse antes; a situação junta as duas pontas.
- Se não houver nada, devolva listas vazias.`;

// Recusas de classificador são raras neste uso, mas uma conversa pessoal pode cair num
// deles; "default" reencaminha no servidor para o modelo indicado pela categoria. O
// Haiku 5.5 não tem esse reencaminhamento: para ele o parâmetro não vai.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

function fallbackPara(modelo: string): Partial<typeof FALLBACK> {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(modelo) ? FALLBACK : {};
}

export function criarIa(opts: {
  modelo: string;
  modeloExtracao: string;
  modeloLeve: string;
  apiKey?: string;
  aoUsar?: (u: Uso) => void;
}): Ia {
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  const modeloDe = (p: { peso?: Peso }) => (p.peso === "leve" ? opts.modeloLeve : opts.modelo);

  function registrar(funcao: string, modelo: string, u: Anthropic.Beta.BetaUsage | undefined): void {
    if (!u || !opts.aoUsar) return;
    opts.aoUsar({
      funcao,
      modelo,
      entrada: u.input_tokens ?? 0,
      saida: u.output_tokens ?? 0,
      cacheLeitura: u.cache_read_input_tokens ?? 0,
      cacheEscrita: u.cache_creation_input_tokens ?? 0,
    });
  }

  return {
    async extrair(e) {
      const conteudo = [
        `Agora: ${e.agora}`,
        `Dono: ${e.dono}`,
        `${e.grupo ? "Grupo" : "Contato"}: ${e.contato}`,
        e.licoes ? `CORREÇÕES QUE O DONO JÁ FEZ EM LEITURAS (valem acima de tudo):\n${e.licoes}` : "",
        e.memoria ? `O que já se sabe:\n${e.memoria}` : "",
        e.anteriores ? `ANTERIOR:\n${e.anteriores}` : "",
        `NOVO:\n${e.novas}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const resp = await client.beta.messages.parse({
        model: opts.modeloExtracao,
        max_tokens: 4000,
        ...fallbackPara(opts.modeloExtracao),
        system: [{ type: "text", text: INSTRUCOES_EXTRACAO, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "low", format: betaZodOutputFormat(ExtracaoSchema) },
        messages: [{ role: "user", content: conteudo }],
      });
      registrar("extracao", opts.modeloExtracao, resp.usage);
      if (resp.stop_reason === "refusal" || !resp.parsed_output) return EXTRACAO_VAZIA;
      return resp.parsed_output;
    },

    async escrever(p) {
      const modelo = modeloDe(p);
      const resp = await client.beta.messages.create({
        model: modelo,
        max_tokens: 8000,
        ...fallbackPara(modelo),
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: p.esforco ?? "medium" },
        messages: [{ role: "user", content: p.conteudo }],
      });
      registrar(p.funcao, modelo, resp.usage);
      if (resp.stop_reason === "refusal") return "";
      return textoDe(resp.content);
    },

    async estruturar(schema, p) {
      const modelo = modeloDe(p);
      const resp = await client.beta.messages.parse({
        model: modelo,
        max_tokens: 8000,
        ...fallbackPara(modelo),
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: p.esforco ?? "medium", format: betaZodOutputFormat(schema) },
        messages: [{ role: "user", content: p.conteudo }],
      });
      registrar(p.funcao, modelo, resp.usage);
      if (resp.stop_reason === "refusal") return null;
      return (resp.parsed_output ?? null) as z.infer<typeof schema> | null;
    },

    async verImagem(imagem, legenda) {
      const tipo = imagem.mimetype.split(";")[0].trim();
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(tipo)) return "";
      const resp = await client.beta.messages.create({
        model: opts.modeloLeve,
        max_tokens: 300,
        system:
          "Descreva a foto que alguém mandou no WhatsApp, numa frase curta em português, com o que importa para responder: o objeto, produto, lugar ou conquista, e a marca ou texto que aparecer. Sem preâmbulo.",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: tipo as "image/jpeg", data: imagem.buffer.toString("base64") } },
              { type: "text", text: legenda ? `Legenda: ${legenda}` : "Sem legenda." },
            ],
          },
        ],
      });
      registrar("imagem", opts.modeloLeve, resp.usage);
      return resp.stop_reason === "refusal" ? "" : textoDe(resp.content).trim();
    },

    async agente(p) {
      // O MCP roda do lado da Anthropic: as ferramentas do KoreOS aparecem para o modelo
      // junto com as locais, e o runner só executa as locais.
      const fb = fallbackPara(opts.modelo);
      const mcp = p.mcp
        ? {
            betas: [...(fb.betas ?? []), "mcp-client-2025-11-20"],
            mcp_servers: [{ type: "url" as const, name: p.mcp.nome, url: p.mcp.url, authorization_token: p.mcp.token }],
          }
        : {};
      const tools = p.mcp ? [...p.ferramentas, { type: "mcp_toolset" as const, mcp_server_name: p.mcp.nome }] : p.ferramentas;
      const runner = client.beta.messages.toolRunner({
        model: opts.modelo,
        max_tokens: 8000,
        ...fb,
        ...mcp,
        max_iterations: 8,
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "medium" },
        tools,
        messages: [{ role: "user", content: p.conteudo }],
      });
      // Cada volta do laço é uma chamada cobrada: soma todas, não só a última.
      let final: Anthropic.Beta.BetaMessage | null = null;
      for await (const msg of runner) {
        registrar(p.funcao ?? "agente", opts.modelo, msg.usage);
        final = msg;
      }
      if (!final) return "";
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
