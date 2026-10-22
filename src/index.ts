import { iniciarAgenda } from "./agenda.js";
import { jidsDoDono, lerConfig } from "./config.js";
import { tratarComando } from "./controle.js";
import { abrirDb, migrar } from "./db.js";
import { rodadaDeExtracao } from "./extracao.js";
import { criarIa } from "./ia.js";
import { ingerir } from "./ingestao.js";
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

const base = { db, ia, dono: cfg.DONO_NOME, fuso: cfg.FUSO, avisar };

const app = criarServidor({
  webhookToken: cfg.WEBHOOK_TOKEN,
  aoEvento: (payload) =>
    ingerir(payload, {
      db,
      jidsDoDono: jidsDoDono(cfg),
      aoComando: async (texto) => {
        // Quem já tem o 🤖 é o próprio assistente (o id pode não ter vindo na resposta do envio).
        if (texto.startsWith("🤖")) return;
        try {
          await tratarComando({ ...base, evolution }, texto);
        } catch (err) {
          app.log.error({ err: String(err) }, "comando falhou");
          await avisar("Deu erro ao fazer isso. Tente de novo em instantes.");
        }
      },
      aoAudio: cfg.OPENAI_API_KEY
        ? async (msg) => {
            const audio = await evolution.baixarMidia(msg.bruto);
            const texto = await transcrever(audio, { apiKey: cfg.OPENAI_API_KEY!, modelo: cfg.MODELO_TRANSCRICAO });
            if (texto) await db.query("UPDATE mensagens SET texto = $2 WHERE id = $1", [msg.id, `[áudio] ${texto}`]);
          }
        : undefined,
      log: (o, t) => app.log.warn(o, t),
    }),
});

const pararAgenda = iniciarAgenda({
  db,
  fuso: cfg.FUSO,
  resumoHora: cfg.RESUMO_HORA,
  intervaloExtracaoSeg: cfg.EXTRACAO_INTERVALO_SEG,
  log: (o, t) => app.log.warn(o, t),
  tarefas: {
    extrair: () => rodadaDeExtracao({ ...base, quietoMin: cfg.EXTRACAO_QUIETO_MIN, log: (o, t) => app.log.warn(o, t) }),
    resumo: async () => avisar(await montarResumo(base)),
    limpar: () => repo.apagarAntigas(db, cfg.RETENCAO_DIAS),
  },
});

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
app.log.info({ migracoes: aplicadas }, "assistente no ar");

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, async () => {
    pararAgenda();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
