/**
 * Transcrição de áudio. A API do Claude não recebe áudio, então este é o único ponto
 * com outro provedor, e só liga com OPENAI_API_KEY. É o mesmo modelo que o KoreOS usa
 * para os áudios do WhatsApp dos clientes.
 */
export async function transcrever(
  audio: { buffer: Buffer; mimetype: string },
  opts: { apiKey: string; modelo: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  const extensao = audio.mimetype.includes("ogg") ? "ogg" : audio.mimetype.split("/")[1] || "ogg";
  form.append("file", new Blob([new Uint8Array(audio.buffer)], { type: audio.mimetype }), `audio.${extensao}`);
  form.append("model", opts.modelo);
  form.append("language", "pt");
  const res = await fetcher("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`transcrição respondeu ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
