import type { Db } from "./db.js";
import { eventoEmTexto } from "./ferramentas_google.js";
import { agoraPorExtenso, dataCurta, relogio } from "./formato.js";
import type { Google } from "./google.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsResumo {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  google?: Google;
}

/** Os dados do resumo, já em texto. Também é o resumo quando o Claude não responde. */
export async function dadosDoResumo(deps: DepsResumo, agora = new Date()): Promise<string> {
  const amanhaFim = new Date(agora.getTime() + 48 * 3600_000);
  const compromissos = await repo.compromissosAbertos(deps.db, amanhaFim);
  const esperando = await repo.esperandoResposta(deps.db, 4);

  const blocos: string[] = [];
  if (deps.google) {
    const fimDoDia = new Date(agora.getTime() + 24 * 3600_000);
    const evs = await deps.google.eventos(agora, fimDoDia).catch(() => []);
    if (evs.length) blocos.push(`*Na agenda*\n${evs.map((e) => eventoEmTexto(e, deps.fuso)).join("\n")}`);
  }
  const { dia } = relogio(agora, deps.fuso);
  const [ano, mes, d] = dia.split("-").map(Number);
  const datas = await repo.datasProximas(deps.db, { ano, mes, dia: d }, 3);
  if (datas.length) {
    blocos.push(
      "*Datas*\n" +
        datas.map((x) => `🎂 ${x.faltam === 0 ? "hoje" : x.faltam === 1 ? "amanhã" : `em ${x.faltam} dias`}: ${x.descricao} — ${x.nome}`).join("\n"),
    );
  }
  const comData = compromissos.filter((c) => c.quando);
  const semData = compromissos.filter((c) => !c.quando && c.responsavel !== "contato");
  if (comData.length) {
    blocos.push(
      "*Agenda (hoje e amanhã)*\n" +
        comData
          .map((c) => {
            const atrasado = c.quando && new Date(c.quando) < agora ? " ⚠️ atrasado" : "";
            return `#${c.id} ${dataCurta(new Date(c.quando!), deps.fuso)} — ${c.descricao} (${c.contato_nome ?? "?"})${atrasado}`;
          })
          .join("\n"),
    );
  }
  if (semData.length) {
    blocos.push(
      "*Promessas sem data*\n" + semData.map((c) => `#${c.id} ${c.descricao} (${c.contato_nome ?? "?"})`).join("\n"),
    );
  }
  if (esperando.length) {
    blocos.push(
      "*Esperando resposta sua*\n" +
        esperando
          .map((e) => `• ${e.nome} (${dataCurta(new Date(e.quando), deps.fuso)}): "${e.ultima.slice(0, 120)}"`)
          .join("\n"),
    );
  }
  return blocos.join("\n\n");
}

export async function montarResumo(deps: DepsResumo, agora = new Date()): Promise<string> {
  const dados = await dadosDoResumo(deps, agora);
  if (!dados) return "Bom dia! Nada pendente por aqui hoje.";
  try {
    const texto = await deps.ia.escrever({
      sistema: `Você é o assistente pessoal de ${deps.dono} e escreve o resumo da manhã dele no WhatsApp.
Curto e direto, em português, com *negrito* do WhatsApp nos títulos. Priorize o que é atrasado e o que é de hoje.
Mantenha os números #N dos compromissos (ele responde com eles). Não invente nada além dos dados.`,
      conteudo: `Agora: ${agoraPorExtenso(agora, deps.fuso)}\n\nDADOS:\n${dados}`,
      esforco: "low",
    });
    return texto || dados;
  } catch {
    return dados;
  }
}
