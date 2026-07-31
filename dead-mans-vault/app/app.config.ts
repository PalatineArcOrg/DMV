import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import {
  resolveDmvBuildIdentity,
  validateFirebasePackage,
} from './src/config/buildIdentityCore.ts';

const APP_DIRECTORY = process.cwd();
const appJson = JSON.parse(
  readFileSync(resolve(APP_DIRECTORY, 'app.json'), 'utf8')
) as { expo: unknown };

export function createDmvExpoConfig(
  environment: Record<string, string | undefined>,
  readFirebase: (path: string) => unknown
): ExpoConfig {
  const resolved = resolveDmvBuildIdentity(environment);
  const firebaseConfig = readFirebase(resolved.googleServicesFile);
  validateFirebasePackage(firebaseConfig, resolved.identity.androidPackage);

  const base = appJson.expo as unknown as ExpoConfig;
  return {
    ...base,
    name: resolved.identity.appName,
    version: resolved.identity.version,
    scheme: resolved.identity.uriScheme,
    runtimeVersion: `${resolved.identity.variant}-${resolved.identity.version}`,
    updates: { enabled: false },
    android: {
      ...base.android,
      package: resolved.identity.androidPackage,
      versionCode: resolved.identity.versionCode,
      allowBackup: false,
      googleServicesFile: resolved.googleServicesFile,
    },
    plugins: [
      ...(base.plugins ?? []),
      [
        './plugins/withDmvBuildIdentity',
        {
          variant: resolved.identity.variant,
          androidPackage: resolved.identity.androidPackage,
          expectedCluster: resolved.identity.expectedCluster,
          firebasePackage: resolved.identity.firebasePackage,
        },
      ],
    ],
    extra: {
      dmvBuildIdentity: resolved.identity,
      eas: { projectId: resolved.identity.easProjectId },
    },
  };
}

export default function createExpoConfig(_context: ConfigContext): ExpoConfig {
  return createDmvExpoConfig(process.env, (file) => {
    const firebasePath = resolve(APP_DIRECTORY, file);
    try {
      return JSON.parse(readFileSync(firebasePath, 'utf8'));
    } catch {
      throw new Error(
        'Selected Firebase configuration is missing or malformed'
      );
    }
  });
}
