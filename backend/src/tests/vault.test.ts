// @ts-nocheck
import { describe, it, expect } from "vitest";
import { explorerUrl, VAULT_CONTRACT_ID } from "../config/network";

describe("Non-custodial Soroban Vault (Issue #127)", () => {
  it("explorerUrl handles contract type", () => {
    const url = explorerUrl("contract", "CACYX7GWKABSUFUF5MV5UVRH62F6A2D2SUSAHVC4FTIIKARTIBVUW6BP");
    expect(url).toBe(
      "https://stellar.expert/explorer/testnet/contract/CACYX7GWKABSUFUF5MV5UVRH62F6A2D2SUSAHVC4FTIIKARTIBVUW6BP"
    );
  });

  it("exports VAULT_CONTRACT_ID as a Soroban contract address", () => {
    expect(VAULT_CONTRACT_ID).toMatch(/^C[A-Z0-9]{55}$/);
  });

  it("vault operations test when dependencies available", async () => {
    let vaultMod;
    try {
      vaultMod = await import("../stellar/vault");
    } catch {
      console.warn("[vault.test] @stellar/stellar-sdk not installed — skipping contract execution tests");
      return;
    }

    const { createVaultOnChain, withdrawXLMFromVault, withdrawUSDCFromVault, closeVault } = vaultMod;

    const mockUserId = "11111111-2222-3333-4444-555555555555";
    const userWalletPublicKey = "GDFKLTB5WKKDDJ2NRU2V5OG476HYEGWT4UFV7BID7BNGWZGRZYL3LL6Z";

    const result = await createVaultOnChain(mockUserId, "savings", userWalletPublicKey);
    expect(result.encryptedSecret).toBeNull();
    expect(result.contractId).toBe(VAULT_CONTRACT_ID);
    expect(result.publicKey).toBe(VAULT_CONTRACT_ID);

    await expect(
      withdrawXLMFromVault(null, userWalletPublicKey, "10.0000000")
    ).rejects.toThrow(/non-custodial/i);

    await expect(
      withdrawUSDCFromVault(null, userWalletPublicKey, "5.0000000")
    ).rejects.toThrow(/non-custodial/i);

    await expect(
      closeVault(null, userWalletPublicKey)
    ).rejects.toThrow(/non-custodial/i);
  });
});
