#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function verifyAndroidArtifactEvidence(evidence, expected) {
  if (!evidence || !expected) {
    throw new Error("Artifact evidence and expectations are required");
  }
  if (
    evidence.androidPackage !== expected.androidPackage ||
    evidence.firebasePackage !== expected.androidPackage
  ) {
    throw new Error("Android or Firebase package identity mismatch");
  }
  if (
    evidence.versionCode !== expected.versionCode ||
    !Number.isSafeInteger(evidence.versionCode) ||
    evidence.versionCode <= 0
  ) {
    throw new Error("Android version code mismatch");
  }
  const expectedFingerprint = String(
    expected.signingCertificateSha256 ?? ""
  ).toUpperCase();
  const observedFingerprint = String(
    evidence.signingCertificateSha256 ?? ""
  ).toUpperCase();
  if (
    !FINGERPRINT.test(expectedFingerprint) ||
    observedFingerprint !== expectedFingerprint
  ) {
    throw new Error("Signing-certificate SHA-256 fingerprint mismatch");
  }
  if (evidence.debuggable !== false) {
    throw new Error("Release artifact is debuggable");
  }
  if (evidence.allowBackup !== false) {
    throw new Error("Release artifact permits Android backup");
  }
  if (evidence.expectedCluster !== "devnet") {
    throw new Error("Only devnet artifacts are permitted");
  }
  if (
    evidence.variant !== expected.variant ||
    (evidence.variant !== "legacy_bridge" && evidence.variant !== "successor")
  ) {
    throw new Error("Build variant mismatch");
  }
  return true;
}

function requireArgument(name, value) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function parseArtifactArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  return {
    apk: requireArgument("--apk", values.get("--apk")),
    androidPackage: requireArgument("--package", values.get("--package")),
    versionCode: Number(
      requireArgument("--version-code", values.get("--version-code"))
    ),
    signingCertificateSha256: requireArgument(
      "--fingerprint",
      values.get("--fingerprint")
    ),
    variant: requireArgument("--variant", values.get("--variant")),
  };
}

function inspectApk(arguments_) {
  const manifest = execFileSync(
    "apkanalyzer",
    ["manifest", "print", arguments_.apk],
    { encoding: "utf8", maxBuffer: 2_000_000 }
  );
  const packageMatch = manifest.match(/\bpackage="([^"]+)"/);
  const versionMatch = manifest.match(/\bandroid:versionCode="([0-9]+)"/);
  const debuggableMatch = manifest.match(/\bandroid:debuggable="([^"]+)"/);
  const backupMatch = manifest.match(/\bandroid:allowBackup="([^"]+)"/);
  const metadata = new Map(
    [
      ...manifest.matchAll(
        /android:name="com\.romulusol\.dmv\.([^"]+)"[\s\S]*?android:value="([^"]+)"/g
      ),
    ].map((match) => [match[1], match[2]])
  );
  const signer = execFileSync(
    "apksigner",
    ["verify", "--print-certs", arguments_.apk],
    { encoding: "utf8", maxBuffer: 100_000 }
  );
  const fingerprintMatch = signer.match(
    /Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)/i
  );
  const digest = fingerprintMatch?.[1]?.toUpperCase() ?? "";
  const fingerprint = digest.match(/../g)?.join(":") ?? "";
  return {
    androidPackage: packageMatch?.[1],
    firebasePackage: metadata.get("FIREBASE_PACKAGE"),
    versionCode: Number(versionMatch?.[1]),
    signingCertificateSha256: fingerprint,
    debuggable: debuggableMatch?.[1] === "true",
    allowBackup: backupMatch?.[1] !== "false",
    expectedCluster: metadata.get("EXPECTED_CLUSTER"),
    variant: metadata.get("BUILD_VARIANT"),
  };
}

export function runArtifactVerifier(argv) {
  const expected = parseArtifactArguments(argv);
  const evidence = inspectApk(expected);
  verifyAndroidArtifactEvidence(evidence, expected);
  process.stdout.write(
    `Verified ${expected.variant} Android artifact identity.\n`
  );
}

if (process.argv[1]?.endsWith("/verify-android-artifact.mjs")) {
  try {
    runArtifactVerifier(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : "Artifact verification failed"
      }\n`
    );
    process.exitCode = 1;
  }
}
