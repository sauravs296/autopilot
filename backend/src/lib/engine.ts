// @ts-nocheck
/**
 * lib/engine.ts
 *
 * Thin bridge — re-exports Stellar utilities from src/stellar/
 * for backward compatibility with existing engine/ and routes/ code.
 *
 * All new code should import directly from src/stellar/*.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { sendXLM, sendUSDC, invokeEngineExecute } from "../stellar/transaction";
import { VAULT_CONTRACT_ID } from "../config/network";
import { getEngineSecret } from "./secrets";

export { fetchRecentPayments } from "../stellar/horizon";
export { loadKeypairFromBlob } from "../stellar/keypair";
export { invokeEngineExecute } from "../stellar/transaction";

type SqlClient = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

/** Engine server keypair — signs all automated transactions */
export async function getEngineKeypair(): Promise<typeof Keypair.prototype> {
  const secret = await getEngineSecret();
  return Keypair.fromSecret(secret);
}

/**
 * Execute an automated rule transaction.
 *
 * In Web3 Soroban mode, invokes AutopilotVault.engine_execute(recipient, amount, token_address, memo)
 * directly on-chain so that smart contract safety controls (pause/unpause, spend limits) are enforced.
 * Falls back to Classic payment if targeting a raw Classic account.
 */
export async function executeRuleTransaction(
  destinationId: string,
  amount: string,
  memoText: string,
  asset: "XLM" | "USDC" = "XLM",
  vaultContractId?: string
): Promise<string> {
  const engine = await getEngineKeypair();
  const targetContractId =
    vaultContractId ?? (destinationId.startsWith("C") ? destinationId : VAULT_CONTRACT_ID);

  if (targetContractId && targetContractId.startsWith("C")) {
    const recipient = destinationId.startsWith("C") ? engine.publicKey() : destinationId;
    return invokeEngineExecute(
      engine,
      targetContractId,
      recipient,
      amount,
      memoText,
      asset
    );
  }

  return asset === "USDC"
    ? sendUSDC(engine, destinationId, amount, memoText)
    : sendXLM(engine, destinationId, amount, memoText);
}

/** Atomically claim a Horizon payment so only one worker can process it. */
export async function claimPayment(
  paymentHorizonId: string,
  userId: string,
  sql: SqlClient
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO "ProcessedPayment" ("paymentId", "userId", "createdAt")
    VALUES (${paymentHorizonId}, ${userId}::uuid, NOW())
    ON CONFLICT ("paymentId") DO NOTHING
    RETURNING "paymentId"
  `;
  return rows.length > 0;
}

export type { StellarPayment } from "../stellar/horizon";
