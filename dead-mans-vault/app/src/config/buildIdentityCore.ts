export const LEGACY_ANDROID_PACKAGE = 'com.romulusol.deadmansvault';
export const LEGACY_EAS_PROJECT_ID = 'b1221e75-1816-4ff6-80bf-8f15f31b27d9';
export const CURRENT_LEGACY_VERSION_CODE = 107;

export type DmvAppVariant = 'legacy_bridge' | 'successor';

export interface DmvBuildIdentity {
  variant: DmvAppVariant;
  androidPackage: string;
  easProjectId: string;
  expectedCluster: 'devnet';
  version: string;
  versionCode: number;
  firebasePackage: string;
  signingIdentityLabel: string;
  appName: string;
  uriScheme: string;
  walletIdentityUri: string;
  notificationChannelLabel: string;
  migrationMode: true;
}

export interface BuildIdentityResolution {
  identity: DmvBuildIdentity;
  googleServicesFile: string;
}

type BuildEnvironment = Record<string, string | undefined>;

function requireValue(environment: BuildEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePositiveInteger(
  environment: BuildEnvironment,
  name: string
): number {
  const raw = requireValue(environment, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireUuid(environment: BuildEnvironment, name: string): string {
  const value = requireValue(environment, name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function requireAndroidPackage(value: string): string {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value)) {
    throw new Error(
      'DMV_SUCCESSOR_ANDROID_PACKAGE must be a valid lowercase Android application ID'
    );
  }
  return value;
}

function requireUriScheme(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/.test(value)) {
    throw new Error('Successor URI scheme is invalid');
  }
  return value;
}

function assertDevnet(environment: BuildEnvironment): void {
  const cluster = requireValue(environment, 'EXPO_PUBLIC_EXPECTED_CLUSTER');
  if (cluster !== 'devnet') {
    throw new Error(
      'Phase 4 Android identities are devnet-only; mainnet builds are disabled'
    );
  }
}

export function resolveDmvBuildIdentity(
  environment: BuildEnvironment
): BuildIdentityResolution {
  assertDevnet(environment);
  const variant = requireValue(environment, 'DMV_APP_VARIANT');
  if (variant === 'legacy_bridge') {
    const versionCode = requirePositiveInteger(
      environment,
      'DMV_LEGACY_BRIDGE_VERSION_CODE'
    );
    if (versionCode <= CURRENT_LEGACY_VERSION_CODE) {
      throw new Error(
        'Legacy bridge version code must exceed the current legacy source build'
      );
    }
    return {
      googleServicesFile:
        environment.DMV_LEGACY_GOOGLE_SERVICES_FILE?.trim() ||
        './google-services.json',
      identity: {
        variant,
        androidPackage: LEGACY_ANDROID_PACKAGE,
        easProjectId: LEGACY_EAS_PROJECT_ID,
        expectedCluster: 'devnet',
        version: requireValue(environment, 'DMV_LEGACY_BRIDGE_VERSION'),
        versionCode,
        firebasePackage: LEGACY_ANDROID_PACKAGE,
        signingIdentityLabel: 'historical-legacy-certificate',
        appName: 'DMV Legacy Bridge',
        uriScheme: 'dmv-legacy-bridge',
        walletIdentityUri: 'https://legacy-bridge.deadmansvault.app',
        notificationChannelLabel: 'DMV Legacy Bridge',
        migrationMode: true,
      },
    };
  }
  if (variant !== 'successor') {
    throw new Error('DMV_APP_VARIANT must be legacy_bridge or successor');
  }

  const androidPackage = requireAndroidPackage(
    requireValue(environment, 'DMV_SUCCESSOR_ANDROID_PACKAGE')
  );
  if (androidPackage === LEGACY_ANDROID_PACKAGE) {
    throw new Error(
      'Successor Android package must differ from the legacy package'
    );
  }
  const buildMode = environment.DMV_BUILD_MODE?.trim() || 'controlled_release';
  if (
    buildMode !== 'test' &&
    /\.(test|debug|dev|temp|temporary)$/.test(androidPackage)
  ) {
    throw new Error(
      'Temporary successor package suffix is forbidden for a controlled release'
    );
  }
  const easProjectId = requireUuid(environment, 'DMV_SUCCESSOR_EAS_PROJECT_ID');
  if (easProjectId === LEGACY_EAS_PROJECT_ID) {
    throw new Error(
      'Successor EAS project must differ from the legacy project'
    );
  }
  const uriScheme = requireUriScheme(
    requireValue(environment, 'DMV_SUCCESSOR_URI_SCHEME')
  );
  if (uriScheme === 'dmv-legacy-bridge') {
    throw new Error('Successor URI scheme must differ from the legacy bridge');
  }

  return {
    googleServicesFile: requireValue(
      environment,
      'DMV_SUCCESSOR_GOOGLE_SERVICES_FILE'
    ),
    identity: {
      variant,
      androidPackage,
      easProjectId,
      expectedCluster: 'devnet',
      version: requireValue(environment, 'DMV_SUCCESSOR_VERSION'),
      versionCode: requirePositiveInteger(
        environment,
        'DMV_SUCCESSOR_VERSION_CODE'
      ),
      firebasePackage: androidPackage,
      signingIdentityLabel: 'successor-controlled-certificate',
      appName: 'DMV Successor',
      uriScheme,
      walletIdentityUri: 'https://successor.deadmansvault.app',
      notificationChannelLabel: 'DMV Successor',
      migrationMode: true,
    },
  };
}

export function getFirebaseAndroidPackages(input: unknown): Array<string> {
  if (!input || typeof input !== 'object') {
    throw new Error('Firebase configuration is malformed');
  }
  const clients = Reflect.get(input, 'client');
  if (!Array.isArray(clients)) {
    throw new Error('Firebase configuration has no Android clients');
  }
  const packages = clients
    .map((client: unknown) => {
      if (!client || typeof client !== 'object') return null;
      const clientInfo = Reflect.get(client, 'client_info');
      if (!clientInfo || typeof clientInfo !== 'object') return null;
      const android = Reflect.get(clientInfo, 'android_client_info');
      if (!android || typeof android !== 'object') return null;
      const packageName = Reflect.get(android, 'package_name');
      return typeof packageName === 'string' ? packageName.trim() : null;
    })
    .filter((value): value is string => Boolean(value));
  if (packages.length === 0) {
    throw new Error('Firebase configuration has no package metadata');
  }
  return Array.from(new Set(packages));
}

export function validateFirebasePackage(
  firebaseConfig: unknown,
  expectedPackage: string
): void {
  const packages = getFirebaseAndroidPackages(firebaseConfig);
  if (packages.length !== 1 || packages[0] !== expectedPackage) {
    throw new Error(
      'Selected Firebase Android client does not match the selected package'
    );
  }
}
