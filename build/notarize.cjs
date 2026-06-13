/* eslint-disable */
// electron-builder afterSign hook.
//
// Notarization happens only if Apple Developer credentials are present in the env.
// In any other case (local dev build, CI without secrets) we exit cleanly so the
// unsigned/unnotarized binary still produces.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set - skipping notarization.'
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] notarizing ${appPath} as ${appleId}…`);
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId
  });
  console.log('[notarize] done.');
};
