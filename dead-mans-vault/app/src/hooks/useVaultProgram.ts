import { useMemo, useCallback } from 'react';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '../utils/ConnectionProvider';
import { useWallet } from './useWallet';
import { idl, DeadMansVault } from '../utils/idl';
import { PROGRAM_ID } from '../utils/constants';
import { VaultTransactionService } from '../services/VaultTransactionService';

const programId = new PublicKey(PROGRAM_ID);

export function useVaultProgram() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  const program = useMemo(() => {
    if (!connection) return null;
    // Read-only provider — no signing needed for fetches
    const readonlyWallet = {
      publicKey: publicKey ?? PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
    };
    const provider = new AnchorProvider(connection, readonlyWallet as any, {
      commitment: 'confirmed',
    });
    return new Program<DeadMansVault>(idl as any, provider);
  }, [connection, publicKey]);

  const getVaultPDA = useCallback((owner: PublicKey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), owner.toBuffer()],
      programId,
    );
  }, []);

  const getHeartbeatPDA = useCallback((vaultConfig: PublicKey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('heartbeat'), vaultConfig.toBuffer()],
      programId,
    );
  }, []);

  const getExecutionPDA = useCallback((vaultConfig: PublicKey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('execution'), vaultConfig.toBuffer()],
      programId,
    );
  }, []);

  const fetchVaultConfig = useCallback(
    async (owner: PublicKey) => {
      if (!program) return null;
      const [pda] = getVaultPDA(owner);
      // Try Anchor deserialization first
      try {
        return await program.account.vaultConfig.fetch(pda);
      } catch {
        // Anchor failed — try raw byte parsing fallback
      }
      try {
        const rawAccount = await connection.getAccountInfo(pda);
        return VaultTransactionService.parseVaultConfigRaw(rawAccount);
      } catch {
        return null;
      }
    },
    [program, connection, getVaultPDA],
  );

  const fetchHeartbeatRecord = useCallback(
    async (vaultConfigPda: PublicKey) => {
      if (!program) return null;
      const [pda] = getHeartbeatPDA(vaultConfigPda);
      try {
        return await program.account.heartbeatRecord.fetch(pda);
      } catch {
        return null;
      }
    },
    [program, getHeartbeatPDA],
  );

  return {
    program,
    programId,
    getVaultPDA,
    getHeartbeatPDA,
    getExecutionPDA,
    fetchVaultConfig,
    fetchHeartbeatRecord,
  };
}
