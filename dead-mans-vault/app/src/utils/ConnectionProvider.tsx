import { Connection, type ConnectionConfig } from '@solana/web3.js';
import React, {
  type FC,
  type ReactNode,
  useMemo,
  createContext,
  useContext,
} from 'react';
import { getRpcUrl } from './rpcConfig';

export interface ConnectionProviderProps {
  children: ReactNode;
  config?: ConnectionConfig;
}

export interface ConnectionContextState {
  connection: Connection;
}

export const ConnectionContext = createContext<ConnectionContextState>(
  {} as ConnectionContextState,
);

export const ConnectionProvider: FC<ConnectionProviderProps> = ({
  children,
  config = { commitment: 'confirmed' },
}) => {
  const connection = useMemo(
    () => new Connection(getRpcUrl(), config),
    [config],
  );

  return (
    <ConnectionContext.Provider value={{ connection }}>
      {children}
    </ConnectionContext.Provider>
  );
};

export function useConnection(): ConnectionContextState {
  return useContext(ConnectionContext);
}
