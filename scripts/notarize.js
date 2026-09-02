/**
 * MaidenPlayer — macOS Notarization Script
 *
 * This script runs automatically after code signing via electron-builder's
 * "afterSign" hook. It submits the signed .app to Apple's notarization
 * service, waits for approval, and staples the notarization ticket.
 *
 * Requirements:
 *   - macOS build machine with Xcode command-line tools
 *   - Environment variables:
 *       APPLE_ID              — Your Apple ID email
 *       APPLE_ID_PASSWORD     — App-specific password (NOT your Apple ID password)
 *       APPLE_TEAM_ID         — Your 10-character Apple Developer Team ID
 *
 * If environment variables are not set, notarization is skipped silently
 * (allowing unsigned development builds to proceed).
 */

const { notarize } = require('@electron/notarize');
const path = require('path');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    console.log('[Notarize] Skipping — not a macOS build');
    return;
  }

  // Check for required environment variables
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !appleTeamId) {
    console.log('[Notarize] Skipping — APPLE_ID, APPLE_ID_PASSWORD, or APPLE_TEAM_ID not set');
    console.log('[Notarize] To enable notarization, set these environment variables:');
    console.log('[Notarize]   export APPLE_ID="your@email.com"');
    console.log('[Notarize]   export APPLE_ID_PASSWORD="xxxx-xxxx-xxxx-xxxx"');
    console.log('[Notarize]   export APPLE_TEAM_ID="XXXXXXXXXX"');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[Notarize] Submitting ${appPath} to Apple notarization service...`);
  console.log(`[Notarize] Apple ID: ${appleId}`);
  console.log(`[Notarize] Team ID: ${appleTeamId}`);
  console.log('[Notarize] This may take several minutes...');

  try {
    await notarize({
      tool: 'notarytool',
      appPath,
      appleId,
      appleIdPassword,
      teamId: appleTeamId,
    });

    console.log('[Notarize] ✅ Notarization complete! Ticket stapled to app.');
  } catch (error) {
    console.error('[Notarize] ❌ Notarization failed:', error.message);
    console.error('[Notarize] The app is signed but NOT notarized.');
    console.error('[Notarize] Users will see a Gatekeeper warning on first launch.');
    // Don't throw — allow the build to complete even if notarization fails
    // The app will still be signed, just not notarized
  }
};
