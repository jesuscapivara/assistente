/**
 * O KoreOS lido direto pelo MCP dele (JSON-RPC sem sessão, `tools/call`), com o token
 * do dono. É para o resumo da manhã: buscar tarefas e contas do dia é consulta de
 * dados, e passar isso pelo Claude custaria as definições de dezenas de ferramentas a
 * cada volta. O agente continua usando o conector MCP da API quando o dono pergunta.
 */

export interface Tarefa {
  titulo: string;
  projeto: string;
  prazo: string; // AAAA-MM-DD
  status: string;
  prioridade: string;
}

export interface Lancamento {
  tipo: "RECEITA" | "DESPESA";
  descricao: string;
  valor: string; // já formatado pelo KoreOS ("R$ 367,49")
  data: string; // vencimento, AAAA-MM-DD
}

export interface KoreosDoDia {
  tarefasHoje: Tarefa[];
  tarefasAtrasadas: Tarefa[];
  contasHoje: Lancamento[];
  contasAtrasadas: Lancamento[];
}

export interface KoreosDireto {
  chamar(ferramenta: string, args: Record<string, unknown>): Promise<unknown>;
}

export function criarKoreosDireto(url: string, token: string, fetcher: typeof fetch = fetch): KoreosDireto {
  let seq = 0;
  return {
    async chamar(ferramenta, args) {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: ferramenta, arguments: args } }),
        signal: AbortSignal.timeout(20_000),
      });
      const texto = await res.text();
      if (!res.ok) throw new Error(`KoreOS ${ferramenta} respondeu ${res.status}: ${texto.slice(0, 200)}`);
      return resultadoDoMcp(texto);
    },
  };
}

/** A resposta pode vir em JSON puro ou num evento SSE (`data: {...}`), conforme o servidor. */
export function resultadoDoMcp(texto: string): unknown {
  const linhaSse = texto
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .at(-1);
  const rpc = JSON.parse(linhaSse ? linhaSse.slice(5) : texto) as { result?: any; error?: { message?: string } };
  if (rpc.error) throw new Error(`KoreOS: ${rpc.error.message ?? "erro"}`);
  const r = rpc.result ?? {};
  if (r.isError) throw new Error(`KoreOS: ${r.content?.[0]?.text ?? "erro na ferramenta"}`);
  if (r.structuredContent) return r.structuredContent;
  const t = r.content?.find((c: { type: string }) => c.type === "text")?.text;
  return t ? JSON.parse(t) : {};
}

const LIMITE = 8;

function tarefas(raw: unknown): Tarefa[] {
  const lista = (raw as { tasks?: any[] })?.tasks ?? [];
  return lista.map((t) => ({
    titulo: String(t.titulo ?? ""),
    projeto: String(t.projeto ?? ""),
    prazo: String(t.prazo ?? ""),
    status: String(t.status ?? ""),
    prioridade: String(t.prioridade ?? ""),
  }));
}

function lancamentos(raw: unknown): Lancamento[] {
  const lista = (raw as { transactions?: any[] })?.transactions ?? [];
  return lista.map((l) => ({
    tipo: l.tipo === "RECEITA" ? "RECEITA" : "DESPESA",
    descricao: String(l.descricao ?? ""),
    valor: String(l.valor ?? ""),
    data: String(l.data ?? ""),
  }));
}

/**
 * O que o KoreOS tem para hoje. `hoje` é o dia civil no fuso do dono (AAAA-MM-DD).
 * "Atrasada" é conferida aqui pelo prazo: o período `atrasadas` do KoreOS devolveu,
 * em 22/10/2026, tarefas com prazo em novembro.
 */
export async function koreosDoDia(k: KoreosDireto, hoje: string): Promise<KoreosDoDia> {
  const [prazoHoje, atrasadas, contasHoje, contasAtrasadas] = await Promise.all([
    k.chamar("tasks_list_mine", { period: "prazo_hoje" }).then(tarefas),
    k.chamar("tasks_list_mine", { period: "atrasadas" }).then(tarefas),
    k.chamar("finance_search_transactions", { period: "vencimento_hoje" }).then(lancamentos),
    k.chamar("finance_search_transactions", { period: "atrasadas" }).then(lancamentos),
  ]);
  return {
    tarefasHoje: prazoHoje.filter((t) => t.prazo === hoje).slice(0, LIMITE),
    tarefasAtrasadas: atrasadas
      .filter((t) => t.prazo && t.prazo < hoje)
      .sort((a, b) => a.prazo.localeCompare(b.prazo))
      .slice(0, LIMITE),
    contasHoje: contasHoje.filter((l) => l.data === hoje).slice(0, LIMITE),
    contasAtrasadas: contasAtrasadas.filter((l) => l.data && l.data < hoje).slice(0, LIMITE),
  };
}

/** "09/10" a partir de "2026-10-09". */
export function diaMes(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}
