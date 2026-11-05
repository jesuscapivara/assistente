import { describe, expect, it } from "vitest";
import { ehPdf, textoDoPdf } from "../src/documento.js";

// Um PDF de uma página com uma linha de texto, escrito à mão: sem arquivo de fixture.
const PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj " +
    "4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 10 50 Td (Proposta R$ 16.000) Tj ET\nendstream endobj " +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>",
);

describe("PDF", () => {
  it("reconhece PDF pelo nome do arquivo gravado", () => {
    expect(ehPdf("[arquivo: Proposta Rossetti.PDF] segue")).toBe(true);
    expect(ehPdf("[arquivo: planta.dwg]")).toBe(false);
    expect(ehPdf("mandei o pdf")).toBe(false);
  });

  it("tira o texto e corta no limite", async () => {
    expect(await textoDoPdf(PDF)).toBe("Proposta R$ 16.000");
    expect(await textoDoPdf(PDF, 8)).toBe("Proposta…");
  });
});
