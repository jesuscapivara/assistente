import { iniciarAgenda, type TarefaDiaria } from "./agenda.js";
import { enviarAgendados, responderSozinho } from "./autonomia.js";
import { desenharCartao, planoDoCartao } from "./cartao.js";
import { expediente, googleLigado, jidsDoDono, lerConfig, urlInterna } from "./config.js";
import { estudar } from "./conhecer.js";
import { registrarUso } from "./consumo.js";
import { depsDaPauta, NIVEIS, responderPedido, tratarComando, type DepsControle } from "./controle.js";
import { corrigirLeitura } from "./corrigir.js";
import { atualizarCaderno, limparCaderno } from "./memoria.js";
import { avaliarOferta } from "./ofertas.js";
import { proporResposta } from "./rascunho.js";
import { abrirDb, gravarEstado, migrar } from "./db.js";
import { relogio } from "./formato.js";
import { lerSituacoesPendentes, rodadaDeExtracao } from "./extracao.js";
import { criarKoreosDireto } from "./koreos.js";
import { guardarImagem } from "./midia.js";
import { cuidarDoItem, gravarPauta, pautaDoCartao } from "./pauta.js";
import { criarGoogle } from "./google.js";
import { criarIa } from "./ia.js";
import { ingerir } from "./ingestao.js";
import { comandoDoPainel, paginaDoPainel } from "./painel.js";
import { briefings, cobrancas, fimDoDia, lembretesNaHora, revisaoSemanal } from "./proativo.js";
import * as repo from "./repo.js";
import { assuntoDe, coletarDia, diasEsperando, ficouParaTras, resumoEmTexto } from "./resumo.js";
import { criarServidor } from "./server.js";
import { criarTelegram } from "./telegram.js";
import { transcrever } from "./transcricao.js";
import { criarEvolution } from "./whatsapp/evolution.js";

const cfg = lerConfig();
const db = abrirDb(cfg.DATABASE_URL);
const aplicadas = await migrar(db);

const evolution = criarEvolution(cfg.EVOLUTION_API_URL, cfg.EVOLUTION_INSTANCE_TOKEN);
const ia = criarIa({
  modelo: cfg.MODELO,
  modeloExtracao: cfg.MODELO_EXTRACAO,
  modeloLeve: cfg.MODELO_LEVE,
  apiKey: cfg.ANTHROPIC_API_KEY,
  aoUsar: (u) => registrarUso(db, u),
});
const google = googleLigado(cfg)
  ? criarGoogle({
      clientId: cfg.GOOGLE_CLIENT_ID!,
      clientSecret: cfg.GOOGLE_CLIENT_SECRET!,
      refreshToken: cfg.GOOGLE_REFRESH_TOKEN!,
      fuso: cfg.FUSO,
    })
  : undefined;
const koreos = cfg.KOREOS_MCP_URL && cfg.KOREOS_MCP_TOKEN ? { url: cfg.KOREOS_MCP_URL, token: cfg.KOREOS_MCP_TOKEN } : undefined;
const donoJid = `${cfg.DONO_NUMERO}@s.whatsapp.net`;

const telegram = cfg.TELEGRAM_BOT_TOKEN ? criarTelegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID) : undefined;
/** Com o chat do dono no Telegram, é por lá que o assistente fala (lá há notificação). */
const peloTelegram = Boolean(telegram && cfg.TELEGRAM_CHAT_ID);

/**
 * Tudo que o assistente diz vai para o dono: pelo Telegram, quando ligado, ou pelo
 * chat dele consigo mesmo no WhatsApp, com 🤖 na frente para não se confundir com o
 * que ele mesmo anota ali. No WhatsApp o id fica guardado para o webhook não tratar
 * a própria resposta como comando.
 */
async function avisar(texto: string, refs = ""): Promise<void> {
  if (peloTelegram) {
    await telegram!.enviarTexto(texto);
  } else {
    const id = await evolution.enviarTexto(donoJid, `🤖 ${texto}`);
    await repo.registrarEnviada(db, id);
  }
  // O que o assistente disse é o contexto da próxima mensagem do dono ("sim", "o segundo").
  await repo.registrarFala(db, "assistente", texto, refs).catch(() => undefined);
}

const log = (o: object, t: string) => app.log.warn(o, t);
// O mesmo token MCP, chamado direto (sem o Claude) para as tarefas e contas do resumo.
const koreosDireto = koreos ? criarKoreosDireto(koreos.url, koreos.token) : undefined;
const base = { db, ia, dono: cfg.DONO_NOME, fuso: cfg.FUSO, avisar, google, koreosDireto, log };

/**
 * O resumo da manhã: o cartão em imagem, com o essencial e os #N na legenda (é por eles
 * que o dono responde). Sem imagem, ou se ela falhar, vai o texto.
 */
async function enviarResumo(): Promise<void> {
  const dia = await coletarDia(base);
  const { texto, refs, pauta: pautaTexto } = resumoEmTexto(dia, cfg.DONO_NOME, cfg.FUSO);
  if (cfg.RESUMO_IMAGEM) {
    try {
      const plano = await planoDoCartao(ia, dia, cfg.DONO_NOME, cfg.FUSO);
      const pauta = pautaDoCartao(dia, plano.precisa);
      // O painel reaproveita a frase do dia, sem chamar o modelo de novo.
      await gravarEstado(db, "manchete", JSON.stringify({ dia: relogio(dia.agora, cfg.FUSO).dia, texto: plano.manchete })).catch(() => undefined);
      const png = await desenharCartao(dia, plano, cfg.FUSO, pauta);
      const compromissos = [...dia.comData, ...dia.semData].map((c) => `#${c.id} ${c.descricao}`).slice(0, 8);
      const comLetra = [...pauta.precisa, ...pauta.ficou].filter((x) => x.letra);
      const legenda = [
        `🤖 ${plano.manchete}`,
        compromissos.length ? `${compromissos.join("\n")}\n_confirma N · feito N · ignora N_` : "",
        comLetra.length ? `_resolvi ${comLetra[0].letra} · adia ${comLetra[0].letra} sábado · ignora ${comLetra[0].letra} · responde ${comLetra[0].letra}_` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (peloTelegram) {
        await telegram!.enviarFoto(png, legenda.replace(/^🤖 /, ""));
      } else {
        const url = `${urlInterna(cfg)}/midia/${guardarImagem(png)}.png`;
        const id = await evolution.enviarImagem(donoJid, url, legenda.slice(0, 1000));
        await repo.registrarEnviada(db, id);
      }
      await gravarPauta(db, comLetra);
      // O que estava na imagem vai por extenso no diálogo: o agente não vê a figura.
      const letraDe = (x: { letra: string } | undefined) => (x?.letra ? `${x.letra}. ` : "");
      const cartao = [
        `[cartão do resumo] ${plano.manchete}`,
        ...plano.atos.map((a) => `${a.faixa}: ${a.frase}`),
        ...plano.precisa.map((p, i) => `Precisa de você: ${letraDe(pauta.precisa[i])}${p.titulo} — ${p.frase}`),
        ...ficouParaTras(dia)
          .slice(0, 5)
          .map((e, i) => `Ficou para trás: ${letraDe(pauta.ficou[i])}${e.nome} (há ${diasEsperando(e, dia.agora)} dias) — ${assuntoDe(e)}`),
        ...plano.resolvido.map((p) => `Resolvido: ${p.frase}`),
        ...compromissos,
      ].join("\n");
      await repo.registrarFala(db, "assistente", cartao, refs).catch(() => undefined);
      return;
    } catch (err) {
      app.log.warn({ err: String(err) }, "cartão do resumo falhou; vai em texto");
    }
  }
  await gravarPauta(db, pautaTexto);
  await avisar(texto, refs);
}

/**
 * Os nomes da agenda do celular, que o webhook não traz para quem nunca escreveu, e o
 * dos grupos, que o webhook nunca traz. Um falhar não impede o outro.
 */
async function sincronizarNomes(): Promise<void> {
  const n = await repo.gravarNomesDaAgenda(db, await evolution.contatos());
  if (n) app.log.info({ n }, "nomes da agenda gravados");
  const g = await repo.gravarNomesDeGrupos(db, await evolution.grupos()).catch((err) => {
    log({ err: String(err) }, "nomes dos grupos falharam");
    return 0;
  });
  if (g) app.log.info({ n: g }, "nomes dos grupos gravados");
}

const depsControle: DepsControle = {
  ...base,
  enviarResumo,
  evolution,
  expediente: expediente(cfg),
  sincronizarAgenda: cfg.AGENDA_SINCRONIZAR,
  koreos,
  autonomiaPadrao: cfg.AUTONOMIA_PADRAO,
};
const depsAutonomia = { ...base, evolution, padrao: cfg.AUTONOMIA_PADRAO, janelaMin: cfg.JANELA_VETO_MIN };

const transcreverAudio = cfg.OPENAI_API_KEY
  ? async (bruto: Record<string, unknown>) =>
      transcrever(await evolution.baixarMidia(bruto), { apiKey: cfg.OPENAI_API_KEY!, modelo: cfg.MODELO_TRANSCRICAO })
  : null;

async function comando(texto: string): Promise<void> {
  // Quem já tem o 🤖 é o próprio assistente (o id pode não ter vindo na resposta do envio).
  if (texto.startsWith("🤖")) return;
  await repo.registrarFala(db, "dono", texto).catch(() => undefined);
  try {
    await tratarComando(depsControle, texto);
  } catch (err) {
    app.log.error({ err: String(err) }, "comando falhou");
    await avisar("Deu erro ao fazer isso. Tente de novo em instantes.");
  }
}

// O histórico chega em vários eventos seguidos: estuda uma vez, 3 min depois do último.
let estudoPendente: NodeJS.Timeout | null = null;
let historicoGravado = 0;
function agendarEstudoDoHistorico(n: number): void {
  historicoGravado += n;
  if (estudoPendente) clearTimeout(estudoPendente);
  estudoPendente = setTimeout(async () => {
    const total = historicoGravado;
    historicoGravado = 0;
    estudoPendente = null;
    try {
      await avisar(`Recebi ${total} mensagens antigas. Vou ler para conhecer as pessoas, leva alguns minutos.`);
      const r = await estudar(base, { fichas: 60, forcarPerfil: true });
      await avisar(`Pronto: ${r}. Mande *perfil* para ver o que eu sei de você.`);
    } catch (err) {
      app.log.error({ err: String(err) }, "estudo do histórico falhou");
    }
  }, 3 * 60_000);
}

const app = criarServidor({
  webhookToken: cfg.WEBHOOK_TOKEN,
  aoEvento: (payload) =>
    ingerir(payload, {
      db,
      jidsDoDono: jidsDoDono(cfg),
      aoComando: (texto) => comando(texto),
      aoComandoAudio: async (msg) => {
        if (!transcreverAudio) return avisar("Para comandos por áudio, configure OPENAI_API_KEY.");
        const texto = await transcreverAudio(msg.bruto).catch(() => "");
        if (!texto) return avisar("Não entendi o áudio. Pode mandar de novo ou escrever?");
        // Mostra o que entendeu: se a transcrição errou, ele vê antes de qualquer rascunho.
        await avisar(`🎙️ "${texto}"`);
        await comando(texto);
      },
      aoAudio: transcreverAudio
        ? async (msg) => {
            const texto = await transcreverAudio(msg.bruto);
            if (texto) await db.query("UPDATE mensagens SET texto = $2 WHERE id = $1", [msg.id, `[áudio] ${texto}`]);
          }
        : undefined,
      aoImagem: async (msg) => {
        const d = await ia.verImagem(await evolution.baixarMidia(msg.bruto), msg.texto);
        if (d) await db.query("UPDATE mensagens SET texto = $2 WHERE id = $1", [msg.id, `[foto: ${d}]${msg.texto ? ` ${msg.texto}` : ""}`]);
      },
      aoOferta: async (jid, grupo, texto) => {
        const aviso = await avaliarOferta(db, jid, grupo, texto);
        if (aviso) await avisar(aviso);
      },
      aoHistorico: async (n) => agendarEstudoDoHistorico(n),
      log,
    }),
  mcp: cfg.MCP_TOKEN ? { token: cfg.MCP_TOKEN, db, dono: cfg.DONO_NOME, fuso: cfg.FUSO, envio: { evolution, avisar } } : undefined,
  painel: cfg.PAINEL_TOKEN
    ? {
        token: cfg.PAINEL_TOKEN,
        pagina: (b, aviso, consulta) => paginaDoPainel(base, b, { fuso: cfg.FUSO, dono: cfg.DONO_NOME, niveis: NIVEIS, padrao: cfg.AUTONOMIA_PADRAO }, aviso, consulta),
        acao: async (campos) => {
          const c = comandoDoPainel(campos);
          if (!c) return "Não entendi esse botão.";
          // Os comandos de sempre respondem no WhatsApp, que é o registro do que foi feito.
          if ("texto" in c) {
            await comando(c.texto);
            return `Feito. A confirmação foi para o seu ${peloTelegram ? "Telegram" : "WhatsApp"}.`;
          }
          if ("autonomia" in c) {
            await repo.definirAutonomia(db, c.autonomia.jid, c.autonomia.nivel);
            return "Nível de autonomia salvo.";
          }
          if ("limparCaderno" in c) {
            await limparCaderno(db);
            return "Caderno zerado.";
          }
          if ("responder" in c) {
            const ct = await repo.lerContato(db, c.responder.jid);
            if (!ct || ct.excluido) return "Essa conversa não está mais no assistente.";
            const id = await proporResposta(depsControle, ct.jid, c.responder.instrucao || `Responder ao que está pendente: ${ct.situacao || "a última mensagem"}.`);
            return `Rascunho #${id} pronto: está aqui embaixo e no seu ${peloTelegram ? "Telegram" : "WhatsApp"}.`;
          }
          if ("corrigir" in c) return corrigirLeitura(depsControle, { jid: c.corrigir.jid }, c.corrigir.texto);
          if ("perguntar" in c) {
            // Pela tela, a conversa fica no diálogo como se fosse no chat: o "sim" seguinte,
            // em qualquer um dos dois, sabe a que responde.
            await repo.registrarFala(db, "dono", c.perguntar).catch(() => undefined);
            const resposta = await responderPedido(depsControle, c.perguntar);
            await repo.registrarFala(db, "assistente", resposta).catch(() => undefined);
            void atualizarCaderno(base).catch(() => undefined);
            return "";
          }
          return cuidarDoItem(depsDaPauta(depsControle), c.pendencia.item, c.pendencia.acao, c.pendencia.quando);
        },
      }
    : undefined,
});

// Como o dono aparece citado num grupo: grupo que não o envolve não custa leitura.
const mencoes = [cfg.DONO_NOME, cfg.DONO_NUMERO, ...cfg.DONO_LIDS.split(",").map((x) => x.trim().split("@")[0])].filter(Boolean);

const diarias: TarefaDiaria[] = [
  { chave: "resumo", hora: cfg.RESUMO_HORA, rodar: enviarResumo },
  { chave: "limpeza", hora: "03:00", rodar: () => repo.apagarAntigas(db, cfg.RETENCAO_DIAS) },
  {
    chave: "estudo",
    hora: "04:00",
    rodar: async () => {
      await sincronizarNomes().catch((err) => log({ err: String(err) }, "agenda do celular falhou"));
      return estudar(base);
    },
  },
  { chave: "cobrancas", hora: "10:00", rodar: () => cobrancas(base, cfg.COBRAR_APOS_DIAS) },
  { chave: "fim_do_dia", hora: "18:00", rodar: () => fimDoDia(base) },
  { chave: "revisao_semanal", hora: "18:30", diaDaSemana: 0, rodar: () => revisaoSemanal(base) },
];

const pararAgenda = iniciarAgenda({
  db,
  fuso: cfg.FUSO,
  log,
  continua: {
    intervaloSeg: cfg.EXTRACAO_INTERVALO_SEG,
    rodar: () =>
      rodadaDeExtracao({
        ...base,
        quietoMin: cfg.EXTRACAO_QUIETO_MIN,
        mencoes,
        aoPrecisarResposta: async (jid) => {
          await responderSozinho(depsAutonomia, jid);
        },
      }),
  },
  porMinuto: [() => enviarAgendados(depsAutonomia), () => briefings(base, cfg.BRIEFING_MIN), () => lembretesNaHora(base, cfg.LEMBRETE_MIN)],
  diarias,
});

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

// Comandos pelo bot do Telegram: os mesmos do chat consigo mesmo, por texto ou áudio.
const pararTelegram = telegram
  ? telegram.ouvir({
      aoTexto: (texto) => comando(texto),
      aoAudio: async (audio) => {
        if (!cfg.OPENAI_API_KEY) return avisar("Para comandos por áudio, configure OPENAI_API_KEY.");
        const texto = await transcrever(audio, { apiKey: cfg.OPENAI_API_KEY, modelo: cfg.MODELO_TRANSCRICAO }).catch(() => "");
        if (!texto) return avisar("Não entendi o áudio. Pode mandar de novo ou escrever?");
        await avisar(`🎙️ "${texto}"`);
        await comando(texto);
      },
      log,
    })
  : () => undefined;
app.log.info(
  { migracoes: aplicadas, google: Boolean(google), koreos: Boolean(koreos), painel: Boolean(cfg.PAINEL_TOKEN), mcp: Boolean(cfg.MCP_TOKEN) },
  "assistente no ar",
);

// Na subida, sem segurar nada: nomes da agenda e a situação das conversas que já
// existiam antes desta leitura (uma vez por conversa; depois, a extração mantém).
void (async () => {
  await sincronizarNomes().catch((err) => log({ err: String(err) }, "agenda do celular falhou"));
  const lidas = await lerSituacoesPendentes({ ...base, quietoMin: 0 });
  if (lidas) app.log.info({ lidas }, "situação das conversas lida");
})();

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, async () => {
    pararAgenda();
    pararTelegram();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
