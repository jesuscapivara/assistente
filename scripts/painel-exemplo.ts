// Gera o painel com dados fictícios num Postgres vazio, para conferir o desenho:
// `DATABASE_URL_TESTE=postgres://... npx tsx scripts/painel-exemplo.ts painel.html`.
// O banco é limpo, como nos testes de fluxo.
import { writeFile } from "node:fs/promises";
import { abrirDb, gravarEstado, migrar } from "../src/db.js";
import { paginaDoPainel } from "../src/painel.js";
import * as repo from "../src/repo.js";

const db = abrirDb(process.env.DATABASE_URL_TESTE!);
await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrar(db);

const ANA = "5511911111111@s.whatsapp.net";
const BRUNO = "5511922222222@s.whatsapp.net";
const PAULO = "5511933333333@s.whatsapp.net";
const dia = 86400_000;
for (const [jid, nome, quando, texto, situacao] of [
  [ANA, "Ana Ribeiro", Date.now() - 6 * 3600_000, "Sábado eu estaria mais livre", "Você convidou a Ana para visitar a obra; ela respondeu que sábado está mais livre — falta você propor o horário."],
  [BRUNO, "Bruno Lima", Date.now() - 7 * dia, "me liga quando puder", "Bruno está ajudando com o certificado digital e pediu que você ligue quando puder."],
  [PAULO, "Paulo Teixeira", Date.now() - 2 * dia, "beleza", ""],
] as const) {
  await repo.garantirContato(db, jid, { grupo: false, nomePush: nome });
  await repo.gravarMensagem(db, { id: `m-${jid}`, chatJid: jid, remetenteJid: jid, remetenteNome: nome, deMim: false, grupo: false, tipo: "texto", texto, enviadaEm: new Date(quando), bruto: {}, jidAlternativo: null }, texto, true);
  if (situacao) await repo.atualizarConversa(db, jid, { situacao, esperaResposta: true });
}
await repo.atualizarFicha(db, PAULO, { relacao: "cliente", resumo: "Cliente da Casa Jardins" });
await repo.criarCompromisso(db, { chatJid: PAULO, descricao: "Mandar o memorial descritivo", quando: new Date(Date.now() + 5 * 3600_000), responsavel: "eu" });
await repo.criarCompromisso(db, { chatJid: PAULO, descricao: "Paulo mandar as medidas da cozinha", quando: new Date(Date.now() + 20 * 3600_000), responsavel: "contato" });
await repo.criarRascunho(db, ANA, "Oi Ana! Sábado às 10h fica bom pra você? Te encontro na obra.", "propor sábado 10h");
await repo.acrescentarPerfil(db, "regra", "Nunca marco nada antes das 9h");
await repo.acrescentarPerfil(db, "leitura", "Quem escreve 'vou ler' é quem lê, mesmo que o arquivo tenha vindo do dono.");
await gravarEstado(db, "caderno", "- propus refazer o resumo com nomes; ele aprovou\n- Ana = 5511911111111@s.whatsapp.net");
for (const [funcao, modelo, entrada, saida] of [
  ["extracao", "claude-haiku-5-5", 15000, 2000],
  ["cartao", "claude-haiku-5-5", 1100, 1900],
  ["agente", "claude-sonnet-5-5", 9000, 700],
  ["rascunho", "claude-sonnet-5-5", 4000, 300],
] as const) {
  await db.query("INSERT INTO consumo (funcao, modelo, entrada, saida) VALUES ($1,$2,$3,$4)", [funcao, modelo, entrada, saida]);
}

const html = await paginaDoPainel(
  { db, ia: null as never, dono: "Lucas", fuso: "America/Sao_Paulo" },
  "/painel/x",
  { fuso: "America/Sao_Paulo", dono: "Lucas", niveis: ["só quando você pede", "propõe", "envia se não vetar", "envia direto"], padrao: 0 },
  "Baixa dada: Bruno Lima saiu da lista.",
);
await writeFile(process.argv[2] ?? "painel.html", html);
await db.end();
console.log("ok");
