const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('node:path');

/**
 * electron-builder afterPack hook - runs AFTER packaging but BEFORE code-signing, so the
 * fuse flips are covered by the signature. Disables the generic-Node-interpreter escape
 * hatches that would otherwise let any local process execute arbitrary code under DevHarbor's
 * signed + notarized + entitled identity (IMPROVEMENT-PLAN 6.2):
 *   - RunAsNode (ELECTRON_RUN_AS_NODE), NODE_OPTIONS, and --inspect → OFF
 *   - OnlyLoadAppFromAsar → ON (refuse to run loose app code)
 *   - Cookie encryption → ON
 *
 * EnableEmbeddedAsarIntegrityValidation is intentionally NOT flipped here: it requires the
 * asar integrity header to be embedded and verified, which can fail launch if the toolchain
 * doesn't embed it - enable only after a notarized build is confirmed to launch with it.
 */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename; // "DevHarbor"
  const electronBinary = path.join(appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName);

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true, // clear Electron's ad-hoc sig so electron-builder re-signs
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  });
};
