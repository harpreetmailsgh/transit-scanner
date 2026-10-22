// Dynamic config layered over app.json.
// The Google Maps Android API key is NEVER committed (this repo is public).
// It is injected from the GOOGLE_MAPS_ANDROID_API_KEY environment variable:
// locally from .env.local (gitignored), on EAS builds from a server-side
// EAS environment variable. Without the variable the config is unchanged,
// so OTA updates and iOS are unaffected.
module.exports = ({ config }) => {
  const apiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  if (!apiKey) return config;
  return {
    ...config,
    android: {
      ...config.android,
      config: {
        ...(config.android ? config.android.config : undefined),
        googleMaps: { apiKey },
      },
    },
  };
};
