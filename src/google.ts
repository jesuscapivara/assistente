/**
 * Agenda e Gmail do dono, pela API REST do Google com um refresh token (gerado uma
 * vez com `scripts/google.mjs`). Sem SDK: são seis chamadas, e o resto do código só
 * conhece a interface `Google`.
 *
 * Escopos: agenda (ler e criar eventos), livre/ocupado, Gmail leitura e rascunho.
 * Não há escopo de envio de e-mail: rascunho de e-mail fica no Gmail para o dono enviar.
 */

export interface Evento {
  id: string;
  titulo: string;
  inicio: Date;
  fim: Date;
  diaInteiro: boolean;
  local: string;
  descricao: string;
  convidados: { email: string; nome: string }[];
}

export interface Email {
  id: string;
  threadId: string;
  de: string;
  para: string;
  assunto: string;
  data: Date;
  trecho: string;
  corpo: string;
  naoLido: boolean;
}

export interface Google {
  eventos(de: Date, ate: Date): Promise<Evento[]>;
  ocupado(de: Date, ate: Date): Promise<{ inicio: Date; fim: Date }[]>;
  criarEvento(e: { titulo: string; inicio: Date; fim: Date; descricao?: string; local?: string }): Promise<string>;
  emails(busca: string, max?: number): Promise<Email[]>;
  email(id: string): Promise<Email>;
  rascunhoEmail(r: { para: string; assunto: string; corpo: string; threadId?: string; emResposta?: string }): Promise<string>;
}

export const ESCOPOS_GOOGLE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

export function criarGoogle(
  cred: { clientId: string; clientSecret: string; refreshToken: string; fuso: string },
  fetcher: typeof fetch = fetch,
): Google {
  let token: { valor: string; expira: number } | null = null;

  async function acesso(): Promise<string> {
    if (token && token.expira > Date.now() + 60_000) return token.valor;
    const res = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(`Google recusou o token: ${j.error ?? res.status}`);
    token = { valor: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.valor;
  }

  async function chamar<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetcher(url, {
      ...init,
      headers: { Authorization: `Bearer ${await acesso()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const texto = await res.text();
    if (!res.ok) throw new Error(`Google ${res.status}: ${texto.slice(0, 300)}`);
    return (texto ? JSON.parse(texto) : {}) as T;
  }

  const CAL = "https://www.googleapis.com/calendar/v3";
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

  return {
    async eventos(de, ate) {
      const q = new URLSearchParams({
        timeMin: de.toISOString(),
        timeMax: ate.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
      });
      const j = await chamar<{ items?: any[] }>(`${CAL}/calendars/primary/events?${q}`);
      return (j.items ?? []).filter((e) => e.status !== "cancelled").map(lerEvento);
    },

    async ocupado(de, ate) {
      const j = await chamar<{ calendars?: { primary?: { busy?: { start: string; end: string }[] } } }>(`${CAL}/freeBusy`, {
        method: "POST",
        body: JSON.stringify({ timeMin: de.toISOString(), timeMax: ate.toISOString(), timeZone: cred.fuso, items: [{ id: "primary" }] }),
      });
      return (j.calendars?.primary?.busy ?? []).map((b) => ({ inicio: new Date(b.start), fim: new Date(b.end) }));
    },

    async criarEvento(e) {
      // Sem convidados, de propósito: convite manda e-mail em nome do dono.
      const j = await chamar<{ id: string }>(`${CAL}/calendars/primary/events?sendUpdates=none`, {
        method: "POST",
        body: JSON.stringify({
          summary: e.titulo,
          description: e.descricao ?? "",
          location: e.local ?? "",
          start: { dateTime: e.inicio.toISOString(), timeZone: cred.fuso },
          end: { dateTime: e.fim.toISOString(), timeZone: cred.fuso },
        }),
      });
      return j.id;
    },

    async emails(busca, max = 15) {
      const q = new URLSearchParams({ q: busca, maxResults: String(max) });
      const j = await chamar<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${q}`);
      const lista: Email[] = [];
      for (const m of j.messages ?? []) {
        const det = await chamar<any>(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
        lista.push(lerEmail(det, false));
      }
      return lista;
    },

    async email(id) {
      return lerEmail(await chamar<any>(`${GMAIL}/messages/${id}?format=full`), true);
    },

    async rascunhoEmail(r) {
      const cabecalhos = [
        `To: ${r.para}`,
        `Subject: ${codificarAssunto(r.assunto)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        ...(r.emResposta ? [`In-Reply-To: ${r.emResposta}`, `References: ${r.emResposta}`] : []),
      ];
      const raw = Buffer.from(`${cabecalhos.join("\r\n")}\r\n\r\n${r.corpo}`, "utf8").toString("base64url");
      const j = await chamar<{ id: string }>(`${GMAIL}/drafts`, {
        method: "POST",
        body: JSON.stringify({ message: { raw, ...(r.threadId ? { threadId: r.threadId } : {}) } }),
      });
      return j.id;
    },
  };
}

function lerEvento(e: any): Evento {
  const diaInteiro = Boolean(e.start?.date && !e.start?.dateTime);
  const inicio = new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`);
  const fim = new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00`);
  return {
    id: e.id,
    titulo: e.summary ?? "(sem título)",
    inicio,
    fim,
    diaInteiro,
    local: e.location ?? "",
    descricao: (e.description ?? "").slice(0, 1000),
    convidados: (e.attendees ?? [])
      .filter((a: any) => !a.self)
      .map((a: any) => ({ email: a.email ?? "", nome: a.displayName ?? "" })),
  };
}

function cabecalho(msg: any, nome: string): string {
  const h = (msg.payload?.headers ?? []).find((x: any) => String(x.name).toLowerCase() === nome.toLowerCase());
  return h?.value ?? "";
}

/** O texto do e-mail: a parte text/plain, ou o HTML sem tags quando não houver. */
function corpoDe(parte: any): string {
  if (!parte) return "";
  if (parte.mimeType === "text/plain" && parte.body?.data) return Buffer.from(parte.body.data, "base64url").toString("utf8");
  for (const p of parte.parts ?? []) {
    const t = corpoDe(p);
    if (t) return t;
  }
  if (parte.mimeType === "text/html" && parte.body?.data) {
    return Buffer.from(parte.body.data, "base64url")
      .toString("utf8")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
  }
  return "";
}

function lerEmail(msg: any, comCorpo: boolean): Email {
  return {
    id: msg.id,
    threadId: msg.threadId,
    de: cabecalho(msg, "From"),
    para: cabecalho(msg, "To"),
    assunto: cabecalho(msg, "Subject"),
    data: new Date(Number(msg.internalDate) || Date.parse(cabecalho(msg, "Date")) || Date.now()),
    trecho: msg.snippet ?? "",
    corpo: comCorpo ? corpoDe(msg.payload).slice(0, 8000) : "",
    naoLido: (msg.labelIds ?? []).includes("UNREAD"),
  };
}

/** Assunto com acento precisa de encoded-word (RFC 2047). */
function codificarAssunto(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** Horários livres de `duracaoMin` dentro do expediente, entre os ocupados. */
export function horariosLivres(
  ocupados: { inicio: Date; fim: Date }[],
  janela: { de: Date; ate: Date },
  duracaoMin: number,
  expediente: { inicioH: number; fimH: number; fuso: string },
  max = 6,
): { inicio: Date; fim: Date }[] {
  const livres: { inicio: Date; fim: Date }[] = [];
  const passo = 30 * 60_000;
  const dur = duracaoMin * 60_000;
  const ord = [...ocupados].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  let t = Math.ceil(janela.de.getTime() / passo) * passo;
  while (t + dur <= janela.ate.getTime() && livres.length < max) {
    const ini = new Date(t);
    const fim = new Date(t + dur);
    const hIni = horaLocal(ini, expediente.fuso);
    const hFim = horaLocal(new Date(t + dur - 1), expediente.fuso);
    const noExpediente = hIni >= expediente.inicioH && hFim < expediente.fimH && diaUtil(ini, expediente.fuso);
    const livre = !ord.some((o) => o.inicio < fim && o.fim > ini);
    if (noExpediente && livre) {
      livres.push({ inicio: ini, fim });
      t += dur; // não oferecer dois horários sobrepostos
    } else {
      t += passo;
    }
  }
  return livres;
}

function horaLocal(d: Date, fuso: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: fuso, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(d);
  const h = Number(p.find((x) => x.type === "hour")?.value);
  const m = Number(p.find((x) => x.type === "minute")?.value);
  return h + m / 60;
}

function diaUtil(d: Date, fuso: string): boolean {
  const dia = new Intl.DateTimeFormat("en-US", { timeZone: fuso, weekday: "short" }).format(d);
  return dia !== "Sat" && dia !== "Sun";
}
