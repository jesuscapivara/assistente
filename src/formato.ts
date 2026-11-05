import type { Mensagem } from "./repo.js";

/** Data e hora no fuso do dono, no formato que se lê no WhatsApp: "21/10 14:32". */
export function dataCurta(d: Date, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(",", "");
}

/** Com o ano, "21/10/2026 14:32": fora do WhatsApp, a conversa pode ser de outro ano. */
export function dataComAno(d: Date, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(",", "");
}

/** "terça-feira, 21/10/2026 14:32 (America/Sao_Paulo)": o "agora" que vai nos prompts. */
export function agoraPorExtenso(d: Date, fuso: string): string {
  const txt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return `${txt} (${fuso})`;
}

/** "HH:MM" e "AAAA-MM-DD" no fuso do dono, para o relógio do agendador. */
export function relogio(d: Date, fuso: string): { dia: string; hora: string } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: fuso,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { dia: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

/**
 * Meia-noite de um dia ("2026-10-22") no fuso do dono, como instante. Evento de dia
 * inteiro vem do Google só com a data; lida no fuso do container (UTC), viraria 21h
 * do dia anterior em São Paulo.
 */
export function meiaNoiteEm(data: string, fuso: string): Date {
  const [a, m, d] = data.split("-").map(Number);
  const utc = Date.UTC(a, m - 1, d);
  const r = relogio(new Date(utc), fuso);
  const [ra, rm, rd] = r.dia.split("-").map(Number);
  const [hh, mm] = r.hora.split(":").map(Number);
  // Quanto o relógio do fuso está à frente do UTC naquele instante (-3h em São Paulo).
  const diferenca = Date.UTC(ra, rm - 1, rd, hh, mm) - utc;
  return new Date(utc - diferenca);
}

/** Conversa em linhas: "[21/10 14:32] Fernanda: texto". */
export function linhas(msgs: Mensagem[], dono: string, contato: string, fuso: string): string {
  return msgs
    .map((m) => {
      const quem = m.de_mim ? dono : m.remetente_nome || contato;
      const texto = m.texto || `[${m.tipo}]`;
      return `[${dataCurta(new Date(m.enviada_em), fuso)}] ${quem}: ${texto}`;
    })
    .join("\n");
}
