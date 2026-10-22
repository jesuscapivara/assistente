import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { z } from "zod";
import { dataCurta, relogio } from "./formato.js";
import type { Ia } from "./ia.js";
import { diaMes } from "./koreos.js";
import { pautaDoCartao, type Item } from "./pauta.js";
import { assuntoDe, diaPorExtenso, diasEsperando, esperandoRecente, ficouParaTras, remetente, type Dia } from "./resumo.js";

/**
 * O resumo da manhã como imagem, no desenho do "morning brief" do Claude: no alto, o
 * dia desenhado como relevo (a altura é a carga de reuniões), uma frase de abertura e
 * três blocos de horário; embaixo, o que precisa do dono e o que já se resolveu.
 * Satori monta o layout e o texto vira curva; o resvg rasteriza. Sem navegador no
 * container.
 */

const COR = {
  fundo: "#FCFCFB",
  faixa: "#F9F9F7",
  tinta: "#2E2C27",
  tintaSuave: "#6B6A63",
  cinza: "#B4B3A8",
  linha: "#E4E3DC",
  borda: "#E1E1DF",
  argila: "#C6613F",
};

const PlanoSchema = z.object({
  manchete: z
    .string()
    .describe("Uma frase, como um amigo entregando o dia, com o nome do dono. Ou o que torna o dia diferente, ou o formato dele; nunca os dois"),
  atos: z
    .array(z.object({ faixa: z.string().describe("Ex.: '8h – 12h', '12h – 15h30', '15h30 em diante'"), frase: z.string() }))
    .describe("Exatamente três blocos do dia (manhã, meio, fim), cada um com uma frase específica tirada da agenda"),
  precisa: z
    .array(z.object({ ref: z.string(), titulo: z.string().describe("Até 10 palavras, nas palavras do dono"), frase: z.string() }))
    .describe("O que custa ignorar até amanhã. Só itens dos dados, pelo ref. Até 6"),
  resolvido: z.array(z.object({ ref: z.string(), frase: z.string() })).describe("O que fechou nas últimas 24h. Só itens dos dados, pelo ref. Até 4"),
});
type Plano = z.infer<typeof PlanoSchema>;

const VOZ = `Observe e entregue, sem mandar: nunca "você precisa", nunca desculpa, nunca enchimento ("você consegue!"), nunca julgar o dia ("bem cheio"), nunca narrar o processo. Português do Brasil.`;

/** Os itens do dia com um ref cada: o modelo escolhe e escreve, mas só sobre o que existe. */
function itensComRef(dia: Dia, fuso: string): { texto: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const linhas: string[] = [];
  const add = (ref: string, txt: string) => {
    refs.set(ref, txt);
    linhas.push(`${ref}: ${txt}`);
  };
  dia.eventosHoje.forEach((e, i) =>
    add(`E${i + 1}`, `[agenda hoje] ${e.diaInteiro ? "dia inteiro" : `${hora(e.inicio, fuso)}–${hora(e.fim, fuso)}`} ${e.titulo}`),
  );
  dia.eventosAmanha.forEach((e, i) => add(`A${i + 1}`, `[agenda amanhã] ${e.diaInteiro ? "dia inteiro" : hora(e.inicio, fuso)} ${e.titulo}`));
  for (const c of dia.comData) {
    const atrasado = new Date(c.quando!) < dia.agora ? " (atrasado)" : "";
    const quem = c.responsavel === "contato" ? `[o contato ficou de fazer, não é tarefa do dono]` : "[compromisso do dono]";
    add(`#${c.id}`, `${quem} ${dataCurta(new Date(c.quando!), fuso)} ${c.descricao} — ${c.contato_nome ?? "?"}${atrasado}`);
  }
  for (const c of dia.semData) add(`#${c.id}`, `[promessa sem data] ${c.descricao} — ${c.contato_nome ?? "?"}`);
  // Quem ficou para trás tem seção própria no cartão, montada dos dados: aqui só os recentes.
  esperandoRecente(dia).forEach((e, i) =>
    add(`W${i + 1}`, `[WhatsApp, espera resposta desde ${dataCurta(new Date(e.quando), fuso)}] ${e.nome}: ${e.situacao || `"${e.ultima.slice(0, 160)}"`}`),
  );
  dia.emails.forEach((e, i) => add(`M${i + 1}`, `[e-mail não lido] de ${remetente(e.de)}: ${e.assunto} — ${e.trecho.slice(0, 160)}`));
  const k = dia.koreos;
  k?.tarefasHoje.forEach((t, i) => add(`T${i + 1}`, `[KoreOS, tarefa do dono que vence hoje] ${t.titulo} — projeto ${t.projeto} (${t.status}, prioridade ${t.prioridade})`));
  k?.tarefasAtrasadas.forEach((t, i) =>
    add(`TA${i + 1}`, `[KoreOS, tarefa do dono atrasada desde ${diaMes(t.prazo)}] ${t.titulo} — projeto ${t.projeto} (${t.status}, prioridade ${t.prioridade})`),
  );
  k?.contasHoje.forEach((l, i) => add(`F${i + 1}`, `[KoreOS, ${l.tipo === "RECEITA" ? "a receber" : "a pagar"} hoje] ${l.descricao} — ${l.valor}`));
  k?.contasAtrasadas.forEach((l, i) =>
    add(`FA${i + 1}`, `[KoreOS, ${l.tipo === "RECEITA" ? "a receber" : "a pagar"} vencido em ${diaMes(l.data)}] ${l.descricao} — ${l.valor}`),
  );
  dia.datas.forEach((d, i) => add(`D${i + 1}`, `[data] ${d.faltam === 0 ? "hoje" : `em ${d.faltam} dias`}: ${d.descricao} — ${d.nome}`));
  dia.resolvidos.forEach((r, i) => add(`R${i + 1}`, `[resolvido ${dataCurta(new Date(r.quando), fuso)}] ${r.descricao} — ${r.contato}`));
  return { texto: linhas.join("\n"), refs };
}

/** Sem modelo (ou se ele falhar): o mesmo cartão, com frases montadas dos dados. */
function planoSemModelo(dia: Dia, dono: string, fuso: string): Plano {
  const n = dia.eventosHoje.filter((e) => !e.diaInteiro).length;
  const manchete =
    n === 0 ? `O dia inteiro é seu, ${dono}.` : n >= 4 ? `Um dia de agenda cheia, ${dono}.` : `Algumas reuniões e espaço no meio, ${dono}.`;
  const blocos = [
    { faixa: "manhã", de: 0, ate: 12 },
    { faixa: "tarde", de: 12, ate: 18 },
    { faixa: "noite", de: 18, ate: 24 },
  ];
  const atos = blocos.map((b) => {
    const evs = dia.eventosHoje.filter((e) => !e.diaInteiro && horaNum(e.inicio, fuso) >= b.de && horaNum(e.inicio, fuso) < b.ate);
    return { faixa: b.faixa, frase: evs.length ? evs.map((e) => `${hora(e.inicio, fuso)} ${e.titulo}`).join(" · ") : "Livre." };
  });
  const precisa = [
    ...(dia.koreos?.tarefasHoje ?? []).map((t, i) => ({ ref: `T${i + 1}`, titulo: t.titulo, frase: `Tarefa do projeto ${t.projeto} no KoreOS, prazo hoje.` })),
    ...(dia.koreos?.contasHoje ?? []).map((l, i) => ({ ref: `F${i + 1}`, titulo: `${l.tipo === "RECEITA" ? "Receber" : "Pagar"} ${l.valor}`, frase: `${l.descricao}, vence hoje no KoreOS.` })),
    ...dia.comData.filter((c) => c.responsavel !== "contato").map((c) => ({ ref: `#${c.id}`, titulo: c.descricao, frase: `Combinado com ${c.contato_nome ?? "?"}, ${dataCurta(new Date(c.quando!), fuso)}.` })),
    ...((dia.koreos?.tarefasAtrasadas.length ?? 0) > 0
      ? [{ ref: "TA1", titulo: dia.koreos!.tarefasAtrasadas.length === 1 ? "1 tarefa atrasada no KoreOS" : `${dia.koreos!.tarefasAtrasadas.length} tarefas atrasadas no KoreOS`, frase: dia.koreos!.tarefasAtrasadas.slice(0, 3).map((t) => `${t.titulo} (${t.projeto})`).join("; ") + "." }]
      : []),
    ...esperandoRecente(dia).map((e, i) => ({ ref: `W${i + 1}`, titulo: `${e.nome} espera resposta`, frase: e.situacao || `"${e.ultima.slice(0, 120)}"` })),
  ].slice(0, 6);
  const resolvido = dia.resolvidos.slice(0, 4).map((r, i) => ({ ref: `R${i + 1}`, frase: `${r.descricao} — ${r.contato}.` }));
  return { manchete, atos, precisa, resolvido };
}

export async function planoDoCartao(ia: Ia | null, dia: Dia, dono: string, fuso: string): Promise<Plano> {
  const base = planoSemModelo(dia, dono, fuso);
  if (!ia) return base;
  const { texto, refs } = itensComRef(dia, fuso);
  const p = await ia
    .estruturar(PlanoSchema, {
      sistema: `Você escreve o resumo da manhã de ${dono}, para ele olhar em 30 segundos com o café.
- manchete: uma frase só. Dia cheio, normal ou livre se vê pela agenda de hoje.
- atos: três blocos de horário cobrindo o dia, cada um com uma frase específica da agenda. Dia calmo: frase curta, sem enchimento.
- precisa: o que custa ignorar até amanhã (alguém travado esperando ele, prazo hoje, preparação para algo de amanhã). Título nas palavras dele; a frase diz de onde vem (WhatsApp, e-mail, agenda, KoreOS, quem, quando) e o que querem.
- Tarefas atrasadas do KoreOS: junte num item só ("5 tarefas atrasadas no KoreOS", citando as de prioridade alta), a não ser que uma delas seja de fato o assunto do dia.
- Contas vencidas do KoreOS: também num item só ("8 contas vencidas no KoreOS", com as duas maiores). Conta que vence hoje pode ter item próprio.
- resolvido: só o que veio marcado como resolvido.
- Use só os itens abaixo, citando o ref exato. Não invente nada.
${VOZ}`,
      conteudo: `Agora: ${diaPorExtenso(dia.agora, fuso)} ${hora(dia.agora, fuso)}\n\nITENS:\n${texto || "(nenhum)"}`,
      esforco: "low",
      peso: "leve",
      funcao: "cartao",
    })
    .catch(() => null);
  if (!p) return base;
  // O que não aponta para um item real não entra: o cartão não pode inventar pendência.
  return {
    manchete: p.manchete || base.manchete,
    atos: p.atos.length === 3 ? p.atos : base.atos,
    precisa: p.precisa.filter((x) => refs.has(x.ref)).slice(0, 6),
    resolvido: p.resolvido.filter((x) => x.ref.startsWith("R") && refs.has(x.ref)).slice(0, 4),
  };
}

function hora(d: Date, fuso: string): string {
  const [h, m] = relogio(d, fuso).hora.split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
}
function horaNum(d: Date, fuso: string): number {
  const [h, m] = relogio(d, fuso).hora.split(":").map(Number);
  return h + m / 60;
}

const LARG = 840;
const ALT = 170;
const DAS = 7;
const ATE = 21;

/**
 * O dia como relevo: um traço só, de ponta a ponta; cada reunião é um morro do tamanho
 * da duração e um ponto em cima. Dia sem reunião é água parada, sem montanha inventada.
 */
export function relevo(dia: Dia, fuso: string): string {
  const evs = dia.eventosHoje
    .filter((e) => !e.diaInteiro)
    .map((e) => ({ ini: horaNum(e.inicio, fuso), fim: Math.max(horaNum(e.fim, fuso), horaNum(e.inicio, fuso) + 0.25) }))
    .filter((e) => e.fim > DAS && e.ini < ATE);
  const x = (h: number) => ((Math.min(Math.max(h, DAS), ATE) - DAS) / (ATE - DAS)) * LARG;
  const horasOcupadas = evs.reduce((s, e) => s + (e.fim - e.ini), 0);
  // A escala vertical vem do dia inteiro: dia pesado sobe mais, dia leve quase não ondula.
  const escala = horasOcupadas >= 5 ? 1 : horasOcupadas >= 2 ? 0.75 : 0.5;
  const base = ALT - 30;
  const altura = (h: number) =>
    evs.reduce((s, e) => {
      const centro = (e.ini + e.fim) / 2;
      const meia = Math.max((e.fim - e.ini) / 2, 0.4);
      return s + Math.exp(-((h - centro) ** 2) / (2 * (meia * 0.9) ** 2)) * 90 * escala * Math.min(1, 0.45 + (e.fim - e.ini) / 2);
    }, 0);
  const pontos: string[] = [];
  for (let i = 0; i <= 140; i++) {
    const h = DAS + ((ATE - DAS) * i) / 140;
    const y = base - Math.min(altura(h), base - 14) + (evs.length ? 0 : Math.sin(i / 6) * 1.5);
    pontos.push(`${((i / 140) * LARG).toFixed(1)},${y.toFixed(1)}`);
  }
  const yEm = (h: number) => base - Math.min(altura(h), base - 14);
  const pontosReuniao = evs.map((e) => {
    const c = (e.ini + e.fim) / 2;
    const r = Math.min(13, 6 + (e.fim - e.ini) * 3);
    return `<circle cx="${x(c).toFixed(1)}" cy="${yEm(c).toFixed(1)}" r="${r.toFixed(1)}" fill="${COR.tinta}"/>`;
  });
  // Um acento de argila só: sol nascendo em dia livre, ou a bandeira do prazo mais próximo.
  const acento = !evs.length
    ? `<circle cx="${x(10)}" cy="${base - 46}" r="16" fill="none" stroke="${COR.argila}" stroke-width="2.5"/>`
    : dia.comData.some((c) => new Date(c.quando!) < new Date(dia.agora.getTime() + 24 * 3600_000))
      ? `<path d="M ${LARG - 40} ${base} L ${LARG - 40} ${base - 44} L ${LARG - 14} ${base - 36} L ${LARG - 40} ${base - 28}" fill="none" stroke="${COR.argila}" stroke-width="2.5" stroke-linejoin="round"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARG}" height="${ALT}" viewBox="0 0 ${LARG} ${ALT}">
<polyline points="${pontos.join(" ")}" fill="none" stroke="${COR.tinta}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
${pontosReuniao.join("\n")}
${acento}
</svg>`;
}

// ── Desenho ──────────────────────────────────────────────────────────────────

type No = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, ...filhos: (No | string | null)[]): No => ({
  type,
  props: { style: { display: "flex", ...style }, children: filhos.filter((f) => f !== null) },
});

/** Satori não desenha emoji sem baixar imagens: some do texto do cartão. */
function limpo(t: string): string {
  return t.replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/\s+/g, " ").trim();
}

/** `marca`: a letra do item (resolvi A, adia B). Sem ela, um ponto: número confundiria com os #N dos compromissos. */
function lista(titulo: string, itens: { titulo?: string; frase: string; marca?: string }[]): No {
  return h(
    "div",
    { flexDirection: "column", marginTop: 34 },
    h("div", { fontSize: 15, fontWeight: 600, color: COR.tinta, letterSpacing: 0.3, marginBottom: 6 }, titulo),
    ...itens.map((it) =>
      h(
        "div",
        { flexDirection: "row", paddingTop: 14, paddingBottom: 14, borderBottom: `1px solid ${COR.linha}` },
        it.marca
          ? h("div", { width: 34, fontSize: 17, fontWeight: 600, color: COR.argila }, it.marca)
          : h("div", { width: 34, fontSize: 17, color: COR.cinza }, "·"),
        h(
          "div",
          { flexDirection: "column", flex: 1 },
          it.titulo ? h("div", { fontSize: 17, fontWeight: 600, color: COR.tinta, marginBottom: 4 }, limpo(it.titulo)) : null,
          h("div", { fontSize: 15, color: COR.tintaSuave, lineHeight: 1.45 }, limpo(it.frase)),
        ),
      ),
    ),
  );
}

let fontes: { name: string; data: Buffer; weight: 400 | 600; style: "normal" }[] | null = null;

async function carregarFontes() {
  if (fontes) return fontes;
  const req = createRequire(import.meta.url);
  const pasta = (pkg: string) => path.join(path.dirname(req.resolve(`${pkg}/package.json`)), "files");
  const ler = (pkg: string, arq: string) => readFile(path.join(pasta(pkg), arq));
  fontes = [
    { name: "Fraunces", data: await ler("@fontsource/fraunces", "fraunces-latin-600-normal.woff"), weight: 600, style: "normal" },
    { name: "Fraunces", data: await ler("@fontsource/fraunces", "fraunces-latin-ext-600-normal.woff"), weight: 600, style: "normal" },
    { name: "Inter", data: await ler("@fontsource/inter", "inter-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Inter", data: await ler("@fontsource/inter", "inter-latin-ext-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Inter", data: await ler("@fontsource/inter", "inter-latin-600-normal.woff"), weight: 600, style: "normal" },
    { name: "Inter", data: await ler("@fontsource/inter", "inter-latin-ext-600-normal.woff"), weight: 600, style: "normal" },
  ];
  return fontes;
}

/** O cartão em PNG (960 px de largura, altura conforme o conteúdo, 2x para nitidez). */
export async function desenharCartao(dia: Dia, plano: Plano, fuso: string, pauta = pautaDoCartao(dia, plano.precisa)): Promise<Buffer> {
  const desenho = `data:image/svg+xml;base64,${Buffer.from(relevo(dia, fuso)).toString("base64")}`;
  const paraTras = ficouParaTras(dia).slice(0, 5);
  // A letra só aparece no que dá para resolver, adiar ou responder daqui.
  const marca = (x: Item | undefined) => x?.letra || undefined;
  const nada = !plano.precisa.length && !plano.resolvido.length && !paraTras.length;
  const arvore = h(
    "div",
    { flexDirection: "column", width: 960, backgroundColor: COR.fundo, fontFamily: "Inter" },
    h(
      "div",
      { flexDirection: "column", backgroundColor: COR.faixa, padding: "48px 60px 40px", borderBottom: `1px solid ${COR.borda}` },
      h("div", { fontSize: 15, color: COR.tintaSuave, marginBottom: 10 }, diaPorExtenso(dia.agora, fuso)),
      h("div", { fontFamily: "Fraunces", fontSize: 40, fontWeight: 600, color: COR.tinta, lineHeight: 1.2 }, limpo(plano.manchete)),
      { type: "img", props: { src: desenho, width: LARG, height: ALT, style: { marginTop: 22 } } },
      h(
        "div",
        { flexDirection: "row", marginTop: 8 },
        ...plano.atos.map((a, i) =>
          h(
            "div",
            {
              flexDirection: "column",
              flex: 1,
              paddingLeft: i ? 18 : 0,
              paddingRight: 18,
              borderLeft: i ? `1px solid ${COR.linha}` : "none",
            },
            h("div", { fontSize: 15, fontWeight: 600, color: COR.tinta, marginBottom: 6 }, limpo(a.faixa)),
            h("div", { fontSize: 15, color: COR.tintaSuave, lineHeight: 1.45 }, limpo(a.frase)),
          ),
        ),
      ),
    ),
    h(
      "div",
      { flexDirection: "column", padding: "8px 60px 52px" },
      nada
        ? h("div", { fontSize: 17, color: COR.tintaSuave, marginTop: 34 }, "Nada precisa de você esta manhã.")
        : null,
      plano.precisa.length ? lista("Precisa de você", plano.precisa.map((p, i) => ({ ...p, marca: marca(pauta.precisa[i]) }))) : null,
      paraTras.length
        ? lista(
            "Ficou para trás",
            paraTras.map((e, i) => ({ titulo: e.nome, frase: `Há ${diasEsperando(e, dia.agora)} dias. ${assuntoDe(e)}`, marca: pauta.ficou[i]?.letra })),
          )
        : null,
      plano.resolvido.length ? lista("Resolvido", plano.resolvido) : null,
    ),
  );
  const svg = await satori(arvore as never, { width: 960, fonts: await carregarFontes() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1920 } }).render().asPng());
}

export type { Plano };
