import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { dataCurta } from "./formato.js";
import { horariosLivres, type Evento, type Google } from "./google.js";

export interface DepsGoogle {
  google: Google;
  fuso: string;
  expediente: { inicioH: number; fimH: number };
}

export function eventoEmTexto(e: Evento, fuso: string): string {
  const quando = e.diaInteiro ? `${dataCurta(e.inicio, fuso).slice(0, 5)} (dia todo)` : `${dataCurta(e.inicio, fuso)}–${dataCurta(e.fim, fuso).slice(6)}`;
  const quem = e.convidados.length ? ` · com ${e.convidados.map((c) => c.nome || c.email).join(", ")}` : "";
  const meet = e.meetLink ? ` · Meet: ${e.meetLink}` : "";
  return `${quando} ${e.titulo}${e.local ? ` · ${e.local}` : ""}${meet}${quem}`;
}

const data = (s: string) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${s}`);
  return d;
};

/** Ferramentas de agenda e e-mail para o agente. Só existem com o Google configurado. */
export function ferramentasGoogle({ google, fuso, expediente }: DepsGoogle) {
  return [
    betaZodTool({
      name: "ver_agenda",
      description: "Eventos da agenda do dono num período.",
      inputSchema: z.object({
        de: z.string().describe("ISO 8601 com fuso"),
        ate: z.string().describe("ISO 8601 com fuso"),
      }),
      run: async ({ de, ate }) => {
        const evs = await google.eventos(data(de), data(ate));
        return evs.length ? evs.map((e) => eventoEmTexto(e, fuso)).join("\n") : "Agenda livre nesse período.";
      },
    }),
    betaZodTool({
      name: "horarios_livres",
      description: "Sugere horários livres na agenda, dentro do expediente e em dia útil.",
      inputSchema: z.object({
        de: z.string().describe("ISO 8601 com fuso: a partir de quando procurar"),
        ate: z.string().describe("ISO 8601 com fuso: até quando"),
        duracao_min: z.number().int().min(15).max(480).default(60),
      }),
      run: async ({ de, ate, duracao_min }) => {
        const janela = { de: data(de), ate: data(ate) };
        const ocupados = await google.ocupado(janela.de, janela.ate);
        const livres = horariosLivres(ocupados, janela, duracao_min, { ...expediente, fuso });
        return livres.length
          ? livres.map((l) => `${dataCurta(l.inicio, fuso)}–${dataCurta(l.fim, fuso).slice(6)}`).join("\n")
          : "Nenhum horário livre nesse período.";
      },
    }),
    betaZodTool({
      name: "criar_evento",
      description:
        "Cria um evento na agenda do dono, sem convidados (não manda convite a ninguém). Use quando ele pedir para marcar ou anotar algo na agenda. Pode gerar link do Google Meet.",
      inputSchema: z.object({
        titulo: z.string(),
        inicio: z.string().describe("ISO 8601 com fuso"),
        fim: z.string().describe("ISO 8601 com fuso"),
        descricao: z.string().optional(),
        local: z.string().optional(),
        gerar_meet: z.boolean().optional().describe("Se verdadeiro, gera automaticamente um link do Google Meet para a reunião"),
      }),
      run: async ({ titulo, inicio, fim, descricao, local, gerar_meet }) => {
        const ini = data(inicio);
        const f = data(fim);
        const conflitos = (await google.eventos(ini, f)).filter((e) => !e.diaInteiro);
        const resId = await google.criarEvento({ titulo, inicio: ini, fim: f, descricao, local, meet: gerar_meet });
        const meet = resId.includes("|") ? `\nLink do Meet: ${resId.split("|")[1]}` : "";
        const aviso = conflitos.length ? ` Atenção: bate com ${conflitos.map((e) => e.titulo).join(", ")}.` : "";
        return `Evento criado: ${dataCurta(ini, fuso)} ${titulo}.${aviso}${meet}`;
      },
    }),
    betaZodTool({
      name: "buscar_emails",
      description:
        "Busca e-mails do dono no Gmail. Aceita a sintaxe de busca do Gmail (ex.: 'is:unread newer_than:2d', 'from:fulano orçamento').",
      inputSchema: z.object({ busca: z.string(), max: z.number().int().min(1).max(25).default(10) }),
      run: async ({ busca, max }) => {
        const lista = await google.emails(busca, max);
        if (!lista.length) return "Nenhum e-mail encontrado.";
        return lista.map((e) => `[${e.id}] ${dataCurta(e.data, fuso)} ${e.naoLido ? "• " : ""}${e.de} — ${e.assunto}\n  ${e.trecho}`).join("\n");
      },
    }),
    betaZodTool({
      name: "ler_email",
      description: "Lê um e-mail inteiro pelo id (da busca).",
      inputSchema: z.object({ id: z.string() }),
      run: async ({ id }) => {
        const e = await google.email(id);
        return `De: ${e.de}\nPara: ${e.para}\nAssunto: ${e.assunto}\nData: ${dataCurta(e.data, fuso)}\nthreadId: ${e.threadId}\n\n${e.corpo || e.trecho}`;
      },
    }),
    betaZodTool({
      name: "rascunhar_email",
      description:
        "Deixa um rascunho de e-mail no Gmail do dono, escrito na voz dele. Não envia: ele revisa e envia pelo Gmail.",
      inputSchema: z.object({
        para: z.string(),
        assunto: z.string(),
        corpo: z.string().describe("O texto completo do e-mail, no jeito de escrever do dono"),
        responder_ao_id: z.string().optional().describe("Id do e-mail que está sendo respondido, se for resposta"),
      }),
      run: async ({ para, assunto, corpo, responder_ao_id }) => {
        let threadId: string | undefined;
        let emResposta: string | undefined;
        if (responder_ao_id) {
          const original = await google.email(responder_ao_id);
          threadId = original.threadId;
          emResposta = original.messageId || undefined;
        }
        await google.rascunhoEmail({ para, assunto, corpo, threadId, emResposta });
        return "Rascunho deixado no Gmail, para ele revisar e enviar.";
      },
    }),
  ];
}
