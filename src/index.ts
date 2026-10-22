import { iniciarAgenda, type TarefaDiaria } from "./agenda.js";
import { enviarAgendados, responderSozinho } from "./autonomia.js";
import { expediente, googleLigado, jidsDoDono, lerConfig } from "./config.js";
import { estudar } from "./conhecer.js";
import { NIVEIS, tratarComando, type DepsControle } from "./controle.js";
import { abrirDb, migrar } from "./db.js";
import { rodadaDeExtracao } from "./extracao.js";
import { criarGoogle } from "./google.js";
import { criarIa } from "./ia.js";
import { ingerir } from "./ingestao.js";
import { comandoDoPainel, paginaDoPainel } from "./painel.js";
import { briefings, cobrancas, fimDoDia, revisaoSemanal } from "./proativo.js";
import * as repo from "./repo.js";
import { montarResumo } from "./resumo.js";
import { criarServidor } from "./server.js";
import { transcrever } from "./transcricao.js";
import { criarEvolution } from "./whatsapp/evolution.js";

const cfg = lerConfig();
const db = abrirDb(cfg.DATABASE_URL);
const aplicadas = await migrar(db);

const evolution = criarEvolution(cfg.EVOLUTION_API_URL, cfg.EVOLUTION_INSTANCE_TOKEN);
const ia = criarIa({ modelo: cfg.MODELO, modeloExtracao: cfg.MODELO_EXTRACAO, apiKey: cfg.ANTHROPIC_API_KEY });
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

/**
 * Tudo que o assistente diz vai para o chat do dono consigo mesmo, com 🤖 na frente
 * para não se confundir com o que ele mesmo anota ali. O id fica guardado para o
 * webhook não tratar a própria resposta como comando.
 */
async function avisar(texto: string): Promise<void> {
  const id = await evolution.enviarTexto(donoJid, `🤖 ${texto}`);
  await repo.registrarEnviada(db, id);
}

const log = (o: object, t: string) => app.log.warn(o, t);
const base = { db, ia, dono: cfg.DONO_NOME, fuso: cfg.FUSO, avisar, google, log };
const depsControle: DepsControle = {
  ...base,
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
      aoHistorico: async (n) => agendarEstudoDoHistorico(n),
      log,
    }),
  painel: cfg.PAINEL_TOKEN
    ? {
        token: cfg.PAINEL_TOKEN,
        pagina: (b) => paginaDoPainel(db, b, { fuso: cfg.FUSO, dono: cfg.DONO_NOME, niveis: NIVEIS, padrao: cfg.AUTONOMIA_PADRAO }),
        acao: async (campos) => {
          const c = comandoDoPainel(campos);
          if (!c) return;
          if ("texto" in c) return comando(c.texto);
          await repo.definirAutonomia(db, c.autonomia.jid, c.autonomia.nivel);
        },
      }
    : undefined,
});

const diarias: TarefaDiaria[] = [
  { chave: "resumo", hora: cfg.RESUMO_HORA, rodar: async () => avisar(await montarResumo(base)) },
  { chave: "limpeza", hora: "03:00", rodar: () => repo.apagarAntigas(db, cfg.RETENCAO_DIAS) },
  { chave: "estudo", hora: "04:00", rodar: () => estudar(base) },
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
        aoPrecisarResposta: async (jid) => {
          await responderSozinho(depsAutonomia, jid);
        },
      }),
  },
  porMinuto: [() => enviarAgendados(depsAutonomia), () => briefings(base, cfg.BRIEFING_MIN)],
  diarias,
});

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
app.log.info(
  { migracoes: aplicadas, google: Boolean(google), koreos: Boolean(koreos), painel: Boolean(cfg.PAINEL_TOKEN) },
  "assistente no ar",
);

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, async () => {
    pararAgenda();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
