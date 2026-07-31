import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseArtifactArguments,
  verifyAndroidArtifactEvidence,
} from "./verify-android-artifact.mjs";

const expected = {
  androidPackage: "com.example.dmv.successor",
  versionCode: 1,
  signingCertificateSha256:
    "AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA",
  variant: "successor",
};

const evidence = {
  ...expected,
  firebasePackage: expected.androidPackage,
  debuggable: false,
  allowBackup: false,
  expectedCluster: "devnet",
  certificateSubject: "CN=Not trusted as identity",
};

test("artifact evidence requires package and SHA-256 fingerprint", () => {
  assert.equal(verifyAndroidArtifactEvidence(evidence, expected), true);
  assert.throws(() =>
    verifyAndroidArtifactEvidence(
      { ...evidence, androidPackage: "com.example.wrong" },
      expected
    )
  );
  assert.throws(() =>
    verifyAndroidArtifactEvidence(
      {
        ...evidence,
        signingCertificateSha256:
          "BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB",
        certificateSubject: evidence.certificateSubject,
      },
      expected
    )
  );
});

test("debuggable, backup-enabled and mainnet artifacts are rejected", () => {
  assert.throws(() =>
    verifyAndroidArtifactEvidence({ ...evidence, debuggable: true }, expected)
  );
  assert.throws(() =>
    verifyAndroidArtifactEvidence({ ...evidence, allowBackup: true }, expected)
  );
  assert.throws(() =>
    verifyAndroidArtifactEvidence(
      { ...evidence, expectedCluster: "mainnet-beta" },
      expected
    )
  );
});

test("certificate subject alone is never accepted as identity", () => {
  assert.throws(() =>
    verifyAndroidArtifactEvidence(
      { ...evidence, signingCertificateSha256: "" },
      expected
    )
  );
});

test("artifact command parsing requires every explicit identity input", () => {
  assert.deepEqual(
    parseArtifactArguments([
      "--apk",
      "/tmp/synthetic.apk",
      "--package",
      expected.androidPackage,
      "--version-code",
      "1",
      "--fingerprint",
      expected.signingCertificateSha256,
      "--variant",
      "successor",
    ]),
    {
      apk: "/tmp/synthetic.apk",
      ...expected,
    }
  );
  assert.throws(() =>
    parseArtifactArguments([
      "--apk",
      "/tmp/synthetic.apk",
      "--package",
      expected.androidPackage,
    ])
  );
});
