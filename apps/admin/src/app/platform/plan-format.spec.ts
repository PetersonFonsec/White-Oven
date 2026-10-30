import { planDate, planName, planTerms } from "./plan-format";

describe("plan formatting", () => {
  it("shows the store's calendar day for a period that starts at its local midnight", () => {
    // Midnight of 1 November in each zone, as stored by the API (UTC instants).
    expect(planDate("2026-11-01T03:00:00.000Z", "America/Sao_Paulo")).toBe(
      "1 de novembro de 2026",
    );
    expect(planDate("2026-10-31T15:00:00.000Z", "Asia/Tokyo")).toBe(
      "1 de novembro de 2026",
    );
    expect(planDate("2026-11-01T00:00:00.000Z", "UTC")).toBe(
      "1 de novembro de 2026",
    );
  });

  it("keeps the store's day when the operator is in another zone (month and year turn)", () => {
    // The same instant is still 31 October / 31 December for an operator in Brazil.
    expect(planDate("2026-10-31T15:00:00.000Z", "America/Sao_Paulo")).toBe(
      "31 de outubro de 2026",
    );
    expect(planDate("2026-12-31T15:00:00.000Z", "Asia/Tokyo")).toBe(
      "1 de janeiro de 2027",
    );
    expect(planDate("2026-12-31T15:00:00.000Z", "America/Sao_Paulo")).toBe(
      "31 de dezembro de 2026",
    );
  });

  it("falls back to UTC, labelled, for an unknown zone and never throws", () => {
    expect(planDate("2026-11-01T00:00:00.000Z", "Mars/Olympus")).toBe(
      "1 de novembro de 2026 (UTC)",
    );
    expect(planDate("not a date", "Asia/Tokyo")).toBe("—");
  });

  it("names plans and describes their recorded values", () => {
    expect(planName("PRO")).toBe("Pro");
    expect(planTerms({ feeBasisPoints: 300, monthlyFeeCents: 0 })).toBe(
      "3% por venda, sem mensalidade",
    );
    expect(planTerms({ feeBasisPoints: 0, monthlyFeeCents: 19900 })).toMatch(
      /^sem comissão por venda, R\$\s199,00 por mês$/,
    );
  });
});
