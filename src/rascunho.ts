import type { Db } from "./db.js";
import { agoraPorExtenso, linhas } from "./formato.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsRascunho {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  avisar(texto: string): Promise<void>;
}

function sistema(dono: string): string {
  return `Você escreve mensagens de WhatsApp em nome de ${dono}, como se fosse ele digitando no celular.
- Imite os EXEMPLOS: tamanho, tom, pontuação, abreviações, uso de emoji e de maiúsculas. Com quem ele é informal, seja informal; com cliente, siga como ele fala com cliente.
- Use só o que está na conversa, na memória e no pedido. Não invente fato, valor, data nem compromisso.
- Se faltar uma informação para a resposta, deixe [preencher: o que falta] no lugar.
- Não se apresente, não diga que é assistente, não explique nada: responda só com o texto da mensagem, pronto para enviar.`;
}

/** Escreve a resposta na voz do dono. Não envia: quem envia é o "ok" no canal de controle. */
export async function escreverRascunho(
  deps: Pick<DepsRascunho, "db" | "ia" | "dono" | "fuso">,
  jid: string,
  pedido: string,
  anterior?: string,
): Promise<string> {
  const contato = await repo.lerContato(deps.db, jid);
  if (!contato) throw new Error("contato não encontrado");
  const nome = repo.nomeDe(contato);
  const conversa = await repo.ultimasMensagens(deps.db, jid, 30);
  const exemplos = await repo.exemplosDoDono(deps.db, jid, 40);

  const conteudo = [
    `Agora: ${agoraPorExtenso(new Date(), deps.fuso)}`,
    `Para: ${nome}${contato.grupo ? " (grupo)" : ""}`,
    contato.memoria ? `O que ${deps.dono} sabe de ${nome}:\n${contato.memoria}` : "",
    exemplos.length ? `EXEMPLOS de como ${deps.dono} escreve:\n${exemplos.map((e) => `> ${e}`).join("\n")}` : "",
    conversa.length ? `CONVERSA (mais recente por último):\n${linhas(conversa, deps.dono, nome, deps.fuso)}` : "",
    anterior ? `Rascunho anterior, que ${deps.dono} pediu para ajustar:\n${anterior}` : "",
    `PEDIDO de ${deps.dono}: ${pedido}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const texto = await deps.ia.escrever({ sistema: sistema(deps.dono), conteudo, esforco: "medium" });
  if (!texto) throw new Error("não consegui escrever a resposta");
  return texto;
}

export function previa(id: number, nome: string, texto: string): string {
  return `Rascunho #${id} para *${nome}*:\n\n${texto}\n\n_ok ${id} · ajusta ${id} <o quê> · descarta ${id}_`;
}

/** Cria o rascunho e manda a prévia para o dono aprovar. */
export async function proporResposta(deps: DepsRascunho, jid: string, pedido: string): Promise<number> {
  const texto = await escreverRascunho(deps, jid, pedido);
  const id = await repo.criarRascunho(deps.db, jid, texto, pedido);
  const contato = await repo.lerContato(deps.db, jid);
  await deps.avisar(previa(id, contato ? repo.nomeDe(contato) : jid, texto));
  return id;
}
