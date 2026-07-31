const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const withDmvBuildIdentity = (config, properties) =>
  withAndroidManifest(config, (manifestConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      manifestConfig.modResults
    );
    application["meta-data"] = [
      ...(application["meta-data"] ?? []).filter(
        (entry) => !entry.$["android:name"].startsWith("com.romulusol.dmv.")
      ),
      {
        $: {
          "android:name": "com.romulusol.dmv.BUILD_VARIANT",
          "android:value": properties.variant,
        },
      },
      {
        $: {
          "android:name": "com.romulusol.dmv.ANDROID_PACKAGE",
          "android:value": properties.androidPackage,
        },
      },
      {
        $: {
          "android:name": "com.romulusol.dmv.EXPECTED_CLUSTER",
          "android:value": properties.expectedCluster,
        },
      },
      {
        $: {
          "android:name": "com.romulusol.dmv.FIREBASE_PACKAGE",
          "android:value": properties.firebasePackage,
        },
      },
    ];
    return manifestConfig;
  });

module.exports = withDmvBuildIdentity;
