/**
 * Checks KMS signing against a real AWS account, using the provider's own signer code.
 * Uses your normal AWS credentials (aws configure / AWS_PROFILE).
 *   PROVIDER_KMS_REGION=af-south-1 npx tsx scripts/kms-smoke.ts
 * Creates one KMS key (~$1/month), signs a Base Sepolia USDC transfer 5 times, checks every
 * signature recovers to the key's address, then schedules the key for deletion in 7 days
 * (cancel with `aws kms cancel-key-deletion` if you want to keep it). Nothing is broadcast.
 */
import { KMSClient, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { addressForKey, awsKmsSigner, kmsAccount } from "../src/kmsSigner.js";

const region = process.env.PROVIDER_KMS_REGION ?? "af-south-1";
const kms = awsKmsSigner(region, "A-CARD KMS signing smoke test (safe to delete)");
const keyId = await kms.createKey({ "acard:user": "kms-smoke-test", "acard:chain": "ethereum" });
console.log("created key", keyId, "in", region);
try {
  const address = await addressForKey(kms, keyId);
  console.log("wallet address", address);
  const account = kmsAccount(kms, keyId, address);
  for (let nonce = 0; nonce < 5; nonce++) {
    const tx = {
      chainId: 84532, type: "eip1559" as const, nonce, to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const, value: 0n, gas: 80000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n,
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 10000n] }),
    };
    const raw = await account.signTransaction!(tx);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as any });
    const ok = from === address && keccak256(serializeTransaction(parseTransaction(raw) as any)) !== "0x";
    console.log(`tx ${nonce}: signer ${from} ${ok ? "OK" : "MISMATCH"}`);
    if (!ok) process.exitCode = 1;
  }
  console.log(process.exitCode ? "FAILED" : "PASS: KMS signatures are valid Ethereum transactions from this wallet");
} finally {
  await new KMSClient({ region }).send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
  console.log("key scheduled for deletion in 7 days");
}
