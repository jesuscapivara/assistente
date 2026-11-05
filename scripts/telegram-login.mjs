// Liga a conta do dono no Telegram ao assistente, uma vez (a sessão dura até ele
// encerrá-la em Configurações > Dispositivos). Na VM, de /root/assistente:
//
//   docker compose run --rm -T assistente node scripts/telegram-login.mjs >> .env
//   docker compose up -d assistente
//
// As perguntas saem no stderr (aparecem na tela); só as três linhas TELEGRAM_* vão para o
// stdout, e daí para o .env. api_id e api_hash vêm de https://my.telegram.org > API
// development tools. Tudo isso vale como senha: não cole em chat nenhum.
import readline from "node:readline/promises";
import tg from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const perguntar = async (p) => (await rl.question(p)).trim();

const apiId = Number(await perguntar("api_id (my.telegram.org): "));
const apiHash = await perguntar("api_hash: ");
if (!apiId || !apiHash) {
  console.error("api_id e api_hash são obrigatórios.");
  process.exit(1);
}

const cliente = new tg.TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
  baseLogger: new Logger(LogLevel.ERROR),
});
await cliente.start({
  phoneNumber: () => perguntar("Seu número com DDI (ex.: +5551999990000): "),
  phoneCode: () => perguntar("Código que o Telegram mandou no app: "),
  password: () => perguntar("Senha da verificação em duas etapas: "),
  onError: (e) => console.error(`Erro: ${e.message}`),
});
const eu = await cliente.getMe();
console.error(`Conta ligada: ${eu.firstName ?? ""} ${eu.lastName ?? ""}`.trim());
process.stdout.write(`\nTELEGRAM_API_ID=${apiId}\nTELEGRAM_API_HASH=${apiHash}\nTELEGRAM_SESSAO=${cliente.session.save()}\n`);
await cliente.disconnect();
rl.close();
process.exit(0);
