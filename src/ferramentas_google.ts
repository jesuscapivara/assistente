import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { dataCurta } from "./formato.js";
import { horariosLivres, type Evento, type Google } from "./google.js";

export interface DepsGoogle {
  google: Google;
  fuso: string;
  expediente: { inicioH: number; fimH: number };
  /**
   * Os e-mails que o dono escreveu, ele mesmo, no chat de controle (ou no painel) nas
   * últimas horas. É a trava do envio: o agente lê mensagens de contatos e e-mails de
   * terceiros, e um texto lá dentro pode pedir "mande isto para fulano@". Só sai e-mail
   * ou convite para endereço que o dono digitou.
   */
  enderecosDoDono: () => Promise<Set<string>>;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Os endereços de um texto, em minúsculas. */
export function enderecosEm(texto: string): string[] {
  return [...new Set((texto.match(EMAIL) ?? []).map((e) => e.toLowerCase()))];
}

/** A lista de destinatários, ou o motivo de recusar. */
async function destinatarios(lista: string[], enderecosDoDono: () => Promise<Set<string>>): Promise<string[] | string> {
  const emails = enderecosEm(lista.join(" "));
  if (!emails.length) return "Nenhum endereço de e-mail válido.";
  const liberados = await enderecosDoDono();
  const fora = emails.filter((e) => !liberados.has(e));
  if (fora.length) {
    return `Recusado: ${fora.join(", ")} não foi escrito por ele no chat. Só envio e convido endereços que ele mesmo digitou. Peça para ele mandar o endereço, ou deixe em rascunho.`;
  }
  return emails;
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
export function ferramentasGoogle({ google, fuso, expediente, enderecosDoDono }: DepsGoogle) {
  return [
    betaZodTool({
      name: "ver_agenda",
      description: "Eventos da agenda do dono num período, com o id de cada um (para convidar alguém depois).",
      inputSchema: z.object({
        de: z.string().describe("ISO 8601 com fuso"),
        ate: z.string().describe("ISO 8601 com fuso"),
      }),
      run: async ({ de, ate }) => {
        const evs = await google.eventos(data(de), data(ate));
        return evs.length ? evs.map((e) => `[${e.id}] ${eventoEmTexto(e, fuso)}`).join("\n") : "Agenda livre nesse período.";
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
        "Cria um evento na agenda do dono. Use quando ele pedir para marcar ou anotar algo na agenda. Pode gerar link do Google Meet. Convidados só se ele pedir para convidar ou incluir alguém: o Google manda o convite por e-mail a eles.",
      inputSchema: z.object({
        titulo: z.string(),
        inicio: z.string().describe("ISO 8601 com fuso"),
        fim: z.string().describe("ISO 8601 com fuso"),
        descricao: z.string().optional(),
        local: z.string().optional(),
        gerar_meet: z.boolean().optional().describe("Se verdadeiro, gera automaticamente um link do Google Meet para a reunião"),
        convidados: z.array(z.string()).optional().describe("E-mails a convidar, só os que ele pediu e escreveu no chat"),
      }),
      run: async ({ titulo, inicio, fim, descricao, local, gerar_meet, convidados }) => {
        const ini = data(inicio);
        const f = data(fim);
        let emails: string[] = [];
        if (convidados?.length) {
          const r = await destinatarios(convidados, enderecosDoDono);
          if (typeof r === "string") return r;
          emails = r;
        }
        const conflitos = (await google.eventos(ini, f)).filter((e) => !e.diaInteiro);
        const resId = await google.criarEvento({ titulo, inicio: ini, fim: f, descricao, local, meet: gerar_meet, convidados: emails });
        const meet = resId.includes("|") ? `\nLink do Meet: ${resId.split("|")[1]}` : "";
        const aviso = conflitos.length ? ` Atenção: bate com ${conflitos.map((e) => e.titulo).join(", ")}.` : "";
        const convite = emails.length ? ` Convite enviado para ${emails.join(", ")}.` : "";
        return `Evento criado: ${dataCurta(ini, fuso)} ${titulo}.${aviso}${convite}${meet}`;
      },
    }),
    betaZodTool({
      name: "convidar_para_evento",
      description:
        "Inclui convidados num evento que já está na agenda (id do ver_agenda). O Google manda o convite por e-mail a eles. Só quando ele pedir para incluir ou convidar alguém.",
      inputSchema: z.object({
        evento_id: z.string(),
        emails: z.array(z.string()).describe("Os e-mails que ele escreveu no chat"),
      }),
      run: async ({ evento_id, emails }) => {
        const r = await destinatarios(emails, enderecosDoDono);
        if (typeof r === "string") return r;
        const e = await google.convidar(evento_id, r);
        return `Convite enviado para ${r.join(", ")}: ${eventoEmTexto(e, fuso)}`;
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
    betaZodTool({
      name: "enviar_email",
      description:
        "Envia um e-mail pelo Gmail do dono, na voz dele. Só quando ele mandar enviar (\"manda\", \"envia\", \"pode mandar\"); se ele só pediu para escrever, use rascunhar_email. O destinatário tem de ser um endereço que ele escreveu no chat.",
      inputSchema: z.object({
        para: z.string().describe("Um ou mais e-mails, separados por vírgula"),
        assunto: z.string(),
        corpo: z.string().describe("O texto completo do e-mail, no jeito de escrever do dono"),
        responder_ao_id: z.string().optional().describe("Id do e-mail que está sendo respondido, se for resposta"),
      }),
      run: async ({ para, assunto, corpo, responder_ao_id }) => {
        const r = await destinatarios([para], enderecosDoDono);
        if (typeof r === "string") return r;
        let threadId: string | undefined;
        let emResposta: string | undefined;
        if (responder_ao_id) {
          const original = await google.email(responder_ao_id);
          threadId = original.threadId;
          emResposta = original.messageId || undefined;
        }
        await google.enviarEmail({ para: r.join(", "), assunto, corpo, threadId, emResposta });
        return `E-mail enviado para ${r.join(", ")}, assunto "${assunto}".`;
      },
    }),
  ];
}
