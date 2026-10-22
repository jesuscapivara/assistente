// Gera um cartão de exemplo, com dados fictícios, para conferir o desenho sem banco
// nem Claude: `npx tsx scripts/cartao-exemplo.ts saida.png`.
import { writeFile } from "node:fs/promises";
import { desenharCartao, planoDoCartao } from "../src/cartao.js";
import type { Dia } from "../src/resumo.js";

const fuso = "America/Sao_Paulo";
const em = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 22, h + 3, m));
const dia: Dia = {
  agora: em(7, 30),
  eventosHoje: [
    { id: "1", titulo: "Reunião de obra — Residencial Aurora", inicio: em(9), fim: em(10, 30), diaInteiro: false, local: "", descricao: "", convidados: [] },
    { id: "2", titulo: "Almoço com a Marina", inicio: em(12, 30), fim: em(13, 30), diaInteiro: false, local: "", descricao: "", convidados: [] },
    { id: "3", titulo: "Revisão de projeto elétrico", inicio: em(16), fim: em(17), diaInteiro: false, local: "", descricao: "", convidados: [] },
  ],
  eventosAmanha: [{ id: "4", titulo: "Apresentação ao cliente — Casa Jardins", inicio: em(34), fim: em(35), diaInteiro: false, local: "", descricao: "", convidados: [] }],
  comData: [{ id: 12, chat_jid: "x", descricao: "Mandar o memorial descritivo", quando: em(18), responsavel: "eu", status: "confirmado", contato_nome: "Paulo Teixeira" }],
  semData: [],
  esperando: [
    { jid: "y", nome: "Ana Ribeiro", ultima: "Sábado eu estaria um pouco mais livre", quando: em(-10), situacao: "Você convidou a Ana para visitar a obra; ela respondeu que sábado está mais livre — falta você propor o horário." },
  ],
  datas: [{ jid: "z", nome: "Carla Mendes", descricao: "aniversário", mes: 10, dia: 23, faltam: 1 }],
  emails: [],
  resolvidos: [{ descricao: "resposta enviada", contato: "João Prado", quando: em(-14) }],
};

const plano = await planoDoCartao(null, dia, "Lucas", fuso);
await writeFile(process.argv[2] ?? "cartao.png", await desenharCartao(dia, plano, fuso));
console.log("ok", plano.manchete);
