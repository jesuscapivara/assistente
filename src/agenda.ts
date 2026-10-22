import { gravarEstado, lerEstado, type Db } from "./db.js";
import { relogio } from "./formato.js";

export interface Tarefas {
  extrair(): Promise<unknown>;
  resumo(): Promise<void>;
  limpar(): Promise<unknown>;
}

/**
 * Relógio do assistente, num processo só. O resumo e a limpeza guardam o último dia
 * em que rodaram: reiniciar o processo às 07:31 não manda o resumo duas vezes, e o
 * dia em que ele estava fora às 07:30 ainda recebe o resumo quando voltar.
 */
export function iniciarAgenda(opts: {
  db: Db;
  fuso: string;
  resumoHora: string;
  intervaloExtracaoSeg: number;
  tarefas: Tarefas;
  log: (o: object, txt: string) => void;
}): () => void {
  let extraindo = false;
  const extracao = setInterval(async () => {
    if (extraindo) return;
    extraindo = true;
    try {
      await opts.tarefas.extrair();
    } catch (err) {
      opts.log({ err: String(err) }, "rodada de extração falhou");
    } finally {
      extraindo = false;
    }
  }, opts.intervaloExtracaoSeg * 1000);

  const minuto = setInterval(() => void tique(opts), 60_000);
  void tique(opts);

  return () => {
    clearInterval(extracao);
    clearInterval(minuto);
  };
}

export async function tique(opts: {
  db: Db;
  fuso: string;
  resumoHora: string;
  tarefas: Tarefas;
  log: (o: object, txt: string) => void;
  agora?: Date;
}): Promise<void> {
  const { dia, hora } = relogio(opts.agora ?? new Date(), opts.fuso);
  try {
    if (hora >= opts.resumoHora && (await lerEstado(opts.db, "resumo:ultimo_dia")) !== dia) {
      await gravarEstado(opts.db, "resumo:ultimo_dia", dia);
      await opts.tarefas.resumo();
    }
    if (hora >= "03:00" && (await lerEstado(opts.db, "limpeza:ultimo_dia")) !== dia) {
      await gravarEstado(opts.db, "limpeza:ultimo_dia", dia);
      await opts.tarefas.limpar();
    }
  } catch (err) {
    opts.log({ err: String(err) }, "agenda falhou");
  }
}
