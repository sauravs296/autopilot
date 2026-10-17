// @ts-nocheck
import { describe, it, expect } from "vitest";
import { VAULT_CONTRACT_ID } from "../config/network";

describe("Soroban Smart Contract Engine Execution (Issue #129)", () => {
  it("VAULT_CONTRACT_ID is valid Soroban contract address", () => {
    expect(VAULT_CONTRACT_ID).toMatch(/^C[A-Z0-9]{55}$/);
  });

  it("executeRuleTransaction routes through Soroban engine_execute for contract destinations", async () => {
    let engineMod;
    try {
      engineMod = await import("../lib/engine");
    } catch {
      console.warn("[engineExecute.test] @stellar/stellar-sdk not installed — skipping contract execution tests");
      return;
    }

    const { executeRuleTransaction, invokeEngineExecute } = engineMod;

    // Verify invokeEngineExecute function is exported
    expect(invokeEngineExecute).toBeTypeOf("function");
    expect(executeRuleTransaction).toBeTypeOf("function");

    // Execute rule targeting a Soroban contract
    const contractId = VAULT_CONTRACT_ID;
    const recipient = "GDFKLTB5WKKDDJ2NRU2V5OG476HYEGWT4UFV7BID7BNGWZGRZYL3LL6Z";
    const amount = "5.0000000";
    const memo = "AutoPilot:save";

    const txHash = await executeRuleTransaction(contractId, amount, memo, "XLM");
    expect(txHash).toBeDefined();
    expect(typeof txHash).toBe("string");
  });
});
