import { gravarEstado, lerEstado, type Db } from "./db.js";
import { relogio } from "./formato.js";

/**
 * Tarefa de horário marcado. Guarda o último dia em que rodou: reiniciar o processo
 * logo depois do horário não repete, e o dia em que ele estava fora no horário ainda
 * roda quando voltar (até a meia-noite).
 */
export interface TarefaDiaria {
  chave: string;
  hora: string; // "HH:MM" no fuso do dono
  /** 0 = domingo … 6 = sábado. Sem isso, todo dia. */
  diaDaSemana?: number;
  rodar(): Promise<unknown>;
}

const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function diaDaSemana(d: Date, fuso: string): number {
  return DIAS.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: fuso, weekday: "short" }).format(d));
}

export function iniciarAgenda(opts: {
  db: Db;
  fuso: string;
  /** Roda a cada `intervaloSeg`, uma de cada vez (extração). */
  continua: { intervaloSeg: number; rodar(): Promise<unknown> };
  /** Roda todo minuto (briefing, envio com janela de veto). */
  porMinuto: (() => Promise<unknown>)[];
  diarias: TarefaDiaria[];
  log: (o: object, txt: string) => void;
}): () => void {
  let ocupado = false;
  const continua = setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await opts.continua.rodar();
    } catch (err) {
      opts.log({ err: String(err) }, "rodada contínua falhou");
    } finally {
      ocupado = false;
    }
  }, opts.continua.intervaloSeg * 1000);

  let noMinuto = false;
  const minuto = async () => {
    if (noMinuto) return;
    noMinuto = true;
    try {
      for (const f of opts.porMinuto) await f().catch((err) => opts.log({ err: String(err) }, "tarefa do minuto falhou"));
      await tique({ db: opts.db, fuso: opts.fuso, diarias: opts.diarias, log: opts.log });
    } finally {
      noMinuto = false;
    }
  };
  const relogioMinuto = setInterval(() => void minuto(), 60_000);
  void minuto();

  return () => {
    clearInterval(continua);
    clearInterval(relogioMinuto);
  };
}

export async function tique(opts: {
  db: Db;
  fuso: string;
  diarias: TarefaDiaria[];
  log: (o: object, txt: string) => void;
  agora?: Date;
}): Promise<void> {
  const agora = opts.agora ?? new Date();
  const { dia, hora } = relogio(agora, opts.fuso);
  const semana = diaDaSemana(agora, opts.fuso);
  for (const t of opts.diarias) {
    if (t.diaDaSemana !== undefined && t.diaDaSemana !== semana) continue;
    if (hora < t.hora) continue;
    const chave = `${t.chave}:ultimo_dia`;
    try {
      if ((await lerEstado(opts.db, chave)) === dia) continue;
      // Grava antes: se a tarefa cair no meio, não repete em laço a cada minuto.
      await gravarEstado(opts.db, chave, dia);
      await t.rodar();
    } catch (err) {
      opts.log({ err: String(err), tarefa: t.chave }, "tarefa diária falhou");
    }
  }
}
