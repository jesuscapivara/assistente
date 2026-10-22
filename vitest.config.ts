import { defineConfig } from "vitest/config";

// Os testes de fluxo recriam o schema do banco de teste: um arquivo de cada vez.
export default defineConfig({ test: { fileParallelism: false } });
