// electron-builder custom Windows sign hook (win.signtoolOptions.sign).
// Signs with Azure Artifact Signing through signtool + the Azure.CodeSigning dlib.
// Env overrides: SIGNTOOL_PATH, AZURE_SIGN_DLIB_PATH, AZURE_SIGN_METADATA.
// Auth is whatever the Azure SDK finds: `az login` locally, AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET in CI.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SIGNTOOL =
  process.env.SIGNTOOL_PATH ||
  "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64\\signtool.exe";
const DLIB =
  process.env.AZURE_SIGN_DLIB_PATH ||
  path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "MicrosoftTrustedSigningClientTools",
    "Azure.CodeSigning.Dlib.dll"
  );
const METADATA = path.resolve(process.env.AZURE_SIGN_METADATA || "metadata.json");
const TIMESTAMP = "http://timestamp.acs.microsoft.com";

function signerSubject(file) {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s = Get-AuthenticodeSignature -LiteralPath $env:SIGN_TARGET; if ($s.SignerCertificate) { $s.SignerCertificate.Subject }",
      ],
      { encoding: "utf8", env: { ...process.env, SIGN_TARGET: file } }
    );
    return out.trim();
  } catch {
    return "";
  }
}

exports.default = async function sign(config) {
  const file = config.path;
  if (!/\.(exe|dll)$/i.test(file)) return;
  if (process.env.AZURE_SIGN_SKIP === "1") return;

  for (const [label, p] of [["signtool", SIGNTOOL], ["Azure.CodeSigning.Dlib.dll", DLIB], ["metadata.json", METADATA]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`sign-windows: ${label} not found at ${p} (override with SIGNTOOL_PATH / AZURE_SIGN_DLIB_PATH / AZURE_SIGN_METADATA)`);
    }
  }

  const subject = signerSubject(file);
  if (subject) {
    console.log(`sign-windows: skipping ${path.basename(file)}, already signed (${subject})`);
    return;
  }

  console.log(`sign-windows: signing ${path.basename(file)}`);
  execFileSync(
    SIGNTOOL,
    ["sign", "/v", "/fd", "SHA256", "/tr", TIMESTAMP, "/td", "SHA256", "/dlib", DLIB, "/dmdf", METADATA, file],
    { stdio: "inherit" }
  );
};
